import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  atomic,
  configSchema,
  emptyState,
  exists,
  json,
  run,
  slug,
  stateSchema,
} from "./files.ts";
import { fleetRoot } from "./launcher.mjs";
import { sync } from "./sync.ts";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = homedir();
const root = process.env.SKILLS_FLEET_ROOT ?? fleetRoot();
const label = "org.wovn.skills-fleet";
const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);

export function launchAgent(node: string, launcher: string, log: string) {
  const xml = (value: string) =>
    value.replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(launcher)}</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>300</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>\n`;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      machine: { type: "string" },
      pnpm: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, commit] = positionals;
  if (values.help || !command) {
    console.log(
      "skills-fleet setup --machine <unique-name> [--pnpm /absolute/path]\nskills-fleet sync\nskills-fleet status [--json]\nskills-fleet uninstall\n\nRequires Node >=22.18, pnpm, Git, and a Wovn token file. Setup installs a user LaunchAgent.",
    );
    return;
  }
  if (command === "status") {
    const state = await json(
      join(root, "state.json"),
      stateSchema,
      emptyState(),
    );
    const read = async (name: string): Promise<unknown> =>
      (await exists(join(root, name)))
        ? JSON.parse(await readFile(join(root, name), "utf8"))
        : null;
    const status = {
      config: await read("config.json"),
      ...state,
      check: await read("check.json"),
      reporting: await read("reporting.json"),
    };
    if (values.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(
        `Installed: ${state.installed ? `${state.installed.commit} at ${state.installed.at}` : "not yet installed"}`,
      );
      console.log(
        `Latest attempt: ${state.attempt?.outcome ?? "none"}${state.attempt?.error ? ` - ${state.attempt.error}` : ""}`,
      );
      console.log(
        `Last check: ${JSON.stringify(status.check)}\nReporting: ${JSON.stringify(status.reporting)}\nLocal state and logs: ${root}`,
      );
    }
    return;
  }
  if (command === "internal-sync") {
    if (!commit || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Invalid commit");
    const lockPid = await readFile(join(root, "sync.lock"), "utf8");
    if (
      lockPid !== String(process.ppid) ||
      process.env.SKILLS_FLEET_LOCK_PID !== lockPid
    )
      throw new Error("Run fleet sync through the launcher");
    const config = await json(join(root, "config.json"), configSchema);
    const state = await sync({ home, root, checkout, commit, config });
    if (state.attempt?.outcome !== "success") process.exitCode = 1;
    return;
  }
  if (command === "sync") {
    if (!(await exists(join(root, "config.json"))))
      throw new Error("Run pnpm fleet setup --machine <name> first");
    // Always use the installed launcher, independent of the current worktree.
    run(process.execPath, [join(root, "launcher.mjs")], {
      cwd: root,
      timeout: 20 * 60_000,
    });
    console.log("Sync finished. Run pnpm fleet status for the result.");
    return;
  }
  if (command === "setup") {
    if (process.platform !== "darwin")
      throw new Error("LaunchAgent setup requires macOS");
    const machine = slug.parse(values.machine);
    const existing = (await exists(join(root, "config.json")))
      ? await json(join(root, "config.json"), configSchema)
      : null;
    if (existing && existing.machine !== machine)
      throw new Error(`This installation is already named ${existing.machine}`);
    const pnpm =
      values.pnpm ?? run("/usr/bin/which", ["pnpm"], { cwd: checkout }).trim();
    if (!isAbsolute(pnpm))
      throw new Error("pnpm must be an absolute executable path");
    run(pnpm, ["--version"], { cwd: checkout });
    // File credentials survive logout/restart without embedding a secret in the plist.
    if (
      !(
        await readFile(join(home, ".config", "wovn-files", "token.txt"), "utf8")
      ).trim()
    )
      throw new Error("Wovn token file is empty");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await exists(join(root, "sync.lock")))
      throw new Error("Sync lock exists; wait for sync to finish before setup");
    await atomic(join(root, "config.json"), {
      machine,
      node: process.execPath,
      pnpm,
    });
    await copyFile(
      join(checkout, "scripts/fleet/launcher.mjs"),
      join(root, "launcher.mjs"),
    );
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(
      plist,
      launchAgent(
        process.execPath,
        join(root, "launcher.mjs"),
        join(root, "launchd.log"),
      ),
      { mode: 0o600 },
    );
    const domain = `gui/${process.getuid!()}`;
    spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], {
      stdio: "ignore",
    });
    run("/bin/launchctl", ["bootstrap", domain, plist], { cwd: root });
    console.log(
      `Registered ${machine}. Sync runs now and every five minutes after desktop login.\nPrivate reports: skills-fleet/${machine}/status.json`,
    );
    return;
  }
  if (command === "uninstall") {
    if (process.platform !== "darwin")
      throw new Error("LaunchAgent removal requires macOS");
    spawnSync(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid!()}/${label}`],
      { stdio: "ignore" },
    );
    await rm(plist, { force: true });
    console.log(
      "Removed the LaunchAgent. Installed skills, local state, and reports are retained.",
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
