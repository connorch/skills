// Installed outside the checkout so fetching a new version cannot replace a running entrypoint.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  copyFile,
  open,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = "https://github.com/connorch/skills.git";
export const fleetRoot = (home = homedir()) =>
  join(home, ".local", "state", "skills-fleet");

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

// Exclusive file creation protects scheduled and manual runs. A dead PID can be reclaimed.
export async function withLock(root, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "sync.lock");
  let handle;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const reclaim = join(root, "sync.reclaim");
      try {
        await mkdir(reclaim);
      } catch (claim) {
        if (claim.code === "EEXIST")
          throw new Error(
            "Lock recovery is already in progress. If no fleet process is running, remove sync.reclaim and retry.",
          );
        throw claim;
      }
      try {
        let busy = false;
        for (const candidate of [path, join(root, "sync.child")]) {
          const text = await readFile(candidate, "utf8").catch(() => null);
          if (text === null) continue;
          const pid = Number(text);
          if (!Number.isSafeInteger(pid) || pid < 1) {
            const info = await stat(candidate).catch(() => null);
            if (info && Date.now() - info.mtimeMs < 60_000) busy = true;
          } else {
            try {
              process.kill(pid, 0);
              busy = true;
            } catch (check) {
              if (check.code !== "ESRCH") busy = true;
            }
          }
        }
        if (busy) return false;
        await rm(join(root, "sync.child"), { force: true });
        await rm(path, { force: true });
      } finally {
        await rm(reclaim, { recursive: true, force: true });
      }
    }
  }
  if (!handle) return false;
  try {
    await operation();
    return true;
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}

function command(bin, args, cwd, timeout = 120_000) {
  const result = spawnSync(bin, args, {
    cwd,
    timeout,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${bin} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  return result.stdout.trim();
}

export async function launch(root = fleetRoot(), source = repository) {
  return withLock(root, async () => {
    try {
      const config = JSON.parse(
        await readFile(join(root, "config.json"), "utf8"),
      );
      const checkout = join(root, "checkout");
      try {
        await stat(join(checkout, ".git"));
      } catch {
        const staging = join(root, "checkout.next");
        await rm(staging, { recursive: true, force: true });
        command(
          "/usr/bin/git",
          ["clone", "--no-checkout", source, staging],
          root,
        );
        await rename(staging, checkout);
      }
      if (
        command("/usr/bin/git", ["remote", "get-url", "origin"], checkout) !==
        source
      ) {
        throw new Error(
          "Managed checkout has an unexpected origin; refusing to change it",
        );
      }
      command(
        "/usr/bin/git",
        ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        checkout,
      );
      const commit = command(
        "/usr/bin/git",
        ["rev-parse", "refs/remotes/origin/main"],
        checkout,
      );
      command(
        "/usr/bin/git",
        ["checkout", "--detach", "--force", commit],
        checkout,
      );
      const readyFile = join(root, "dependencies.json");
      const ready = await readFile(readyFile, "utf8").catch(() => "");
      if (ready.trim() !== JSON.stringify(commit)) {
        command(
          config.pnpm,
          ["install", "--frozen-lockfile", "--ignore-scripts"],
          checkout,
        );
        await save(readyFile, commit);
      }
      // Keep launcher failures local. Only the runtime knows whether installation was attempted.
      await new Promise((resolve, reject) => {
        const child = spawn(
          config.node,
          [join(checkout, "scripts/fleet/cli.ts"), "internal-sync", commit],
          {
            cwd: checkout,
            stdio: "inherit",
            detached: true,
            env: {
              ...process.env,
              SKILLS_FLEET_ROOT: root,
              SKILLS_FLEET_LOCK_PID: String(process.pid),
            },
          },
        );
        const pidSaved = child.pid
          ? writeFile(join(root, "sync.child"), String(child.pid))
          : Promise.resolve();
        const stopGroup = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
          }
        };
        const timer = setTimeout(stopGroup, 15 * 60_000);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", async (code) => {
          clearTimeout(timer);
          stopGroup();
          try {
            await pidSaved;
            await rm(join(root, "sync.child"), { force: true });
            if (code === 0) resolve();
            else
              reject(
                new Error("Sync failed; see status and installation logs"),
              );
          } catch (error) {
            reject(error);
          }
        });
      });
      // Adopt a new launcher only after the new runtime completes successfully.
      const temp = join(root, "launcher.next.mjs");
      await copyFile(join(checkout, "scripts/fleet/launcher.mjs"), temp);
      await rename(temp, join(root, "launcher.mjs"));
      await save(join(root, "check.json"), {
        checkedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      await save(join(root, "check.json"), {
        checkedAt: new Date().toISOString(),
        error: error.message,
      });
      throw error;
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  launch()
    .then((ran) => {
      if (!ran) console.log("A fleet sync is already running.");
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
