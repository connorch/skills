import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomic,
  configSchema,
  exists,
  fingerprint,
  json,
  stateSchema,
} from "../scripts/fleet/files.ts";
import { install, readSkills } from "../scripts/fleet/installer.ts";
import { sync } from "../scripts/fleet/sync.ts";
import { publish, reportSchema } from "../scripts/fleet/reports.ts";
import { launchAgent } from "../scripts/fleet/cli.ts";
import { withLock } from "../scripts/fleet/launcher.mjs";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "skills-fleet-test-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"),
    root = join(dir, "state"),
    checkout = join(dir, "repo");
  await Promise.all([
    mkdir(home),
    mkdir(root),
    mkdir(join(checkout, "skills"), { recursive: true }),
  ]);
  const config = configSchema.parse({
    machine: "test-mac",
    node: process.execPath,
    pnpm: "/unused/pnpm",
  });
  const options = { home, root, checkout, config, report: async () => {} };
  const skill = async (name: string, agents?: string) => {
    const path = join(checkout, "skills", name);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill\n${agents === undefined ? "" : `metadata:\n  install-agents: ${JSON.stringify(agents)}\n`}---\nTest instructions.\n`,
    );
  };
  return { ...options, options, skill };
}

test("real CLI placement: default shared, Claude-only copied, upstream slugs accepted", async (t) => {
  const f = await fixture(t);
  await f.skill("shared");
  await f.skill("delegation", "claude-code");
  await f.skill("other", "cursor, opencode");
  const result = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(result.attempt?.outcome, "success", result.attempt?.error ?? "");
  assert.equal(
    (await exists(join(f.home, ".claude/skills/shared")))?.isSymbolicLink(),
    true,
  );
  assert.equal(
    (await exists(join(f.home, ".claude/skills/delegation")))?.isDirectory(),
    true,
  );
  assert.equal(await exists(join(f.home, ".agents/skills/delegation")), null);
  assert.ok(await exists(join(f.home, ".agents/skills/other/SKILL.md")));
});

test("unchanged commit skips installs and new reports after successful publication", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  let installs = 0,
    reports = 0;
  const options = {
    ...f.options,
    commit: "a".repeat(40),
    installSkill: (...args: Parameters<typeof install>) => {
      installs++;
      return install(...args);
    },
    report: async (root: string) => {
      const dir = join(root, "outbox");
      for (const name of await readdir(dir)) {
        reports++;
        await rm(join(dir, name));
      }
    },
  };
  await sync(options);
  await sync(options);
  assert.equal(installs, 1);
  assert.equal(reports, 1);
});

test("rename and removal clean managed placements and preserve unrelated skills", async (t) => {
  const f = await fixture(t);
  await f.skill("old-name");
  await sync({ ...f.options, commit: "a".repeat(40) });
  const unrelated = join(f.home, ".agents/skills/third-party");
  await mkdir(unrelated);
  await writeFile(
    join(unrelated, "SKILL.md"),
    "---\nname: third-party\ndescription: Unrelated\n---\nKeep me\n",
  );
  const before = await fingerprint(unrelated);
  await rm(join(f.checkout, "skills/old-name"), { recursive: true });
  await f.skill("new-name");
  const result = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(result.attempt?.outcome, "success", result.attempt?.error ?? "");
  assert.equal(await exists(join(f.home, ".agents/skills/old-name")), null);
  assert.equal(await exists(join(f.home, ".claude/skills/old-name")), null);
  assert.ok(await exists(join(f.home, ".agents/skills/new-name")));
  assert.equal(await fingerprint(unrelated), before);
});

test("shared to Claude-only removes shared copy; switching back restores it", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  await sync({ ...f.options, commit: "a".repeat(40) });
  await f.skill("example", "claude-code");
  const changed = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(
    changed.attempt?.outcome,
    "success",
    changed.attempt?.error ?? "",
  );
  assert.equal(await exists(join(f.home, ".agents/skills/example")), null);
  assert.equal(
    (await exists(join(f.home, ".claude/skills/example")))?.isDirectory(),
    true,
  );
  await f.skill("example");
  const restored = await sync({ ...f.options, commit: "c".repeat(40) });
  assert.equal(
    restored.attempt?.outcome,
    "success",
    restored.attempt?.error ?? "",
  );
  assert.equal(
    (await exists(join(f.home, ".claude/skills/example")))?.isSymbolicLink(),
    true,
  );
});

test("preflight rejects unknown targets before installing any valid skills", async (t) => {
  const f = await fixture(t);
  await f.skill("first");
  await f.skill("second", "not-an-agent");
  const result = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(result.attempt?.outcome, "failed");
  assert.match(result.attempt?.error ?? "", /Invalid agents/);
  assert.equal(await exists(join(f.home, ".agents")), null);
});

test("unknown same-name installation is not overwritten", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  const path = join(f.home, ".agents/skills/example");
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    "---\nname: example\ndescription: Different origin\n---\nKeep\n",
  );
  const before = await fingerprint(path);
  const result = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(result.attempt?.outcome, "failed");
  assert.match(result.attempt?.error ?? "", /ownership/);
  assert.equal(await fingerprint(path), before);
});

test("exact existing CLI installation can be adopted without name-only trust", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  install((await readSkills(f.checkout))[0], f.home);
  const state = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(state.attempt?.outcome, "success", state.attempt?.error ?? "");
  assert.equal(state.managed.length, 2);
});

test("partial installation retains last successful commit and retries same target", async (t) => {
  const f = await fixture(t);
  await f.skill("first");
  await sync({ ...f.options, commit: "a".repeat(40) });
  await f.skill("second");
  const result = await sync({
    ...f.options,
    commit: "b".repeat(40),
    installSkill: (skill, home) => {
      const output = install(skill, home);
      if (skill.name === "second") throw new Error("Injected interruption");
      return output;
    },
  });
  assert.equal(result.attempt?.outcome, "partial");
  assert.equal(result.installed?.commit, "a".repeat(40));
  const recovered = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(
    recovered.attempt?.outcome,
    "success",
    recovered.attempt?.error ?? "",
  );
  assert.equal(recovered.installed?.commit, "b".repeat(40));
});

test("symlinked parent fails closed instead of writing outside home", async (t) => {
  const { symlink } = await import("node:fs/promises");
  const f = await fixture(t);
  await f.skill("example");
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.home, ".agents"));
  const result = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(result.attempt?.outcome, "failed");
  assert.match(result.attempt?.error ?? "", /Symlinked/);
  assert.deepEqual(await readdir(outside), []);
});

test("Wovn outage keeps local success and retries privately without losing logs", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  const tokenDir = join(f.home, ".config/wovn-files");
  await mkdir(tokenDir, { recursive: true });
  await writeFile(join(tokenDir, "token.txt"), "test-token");
  const seen: { url: string; body: string }[] = [];
  let outage = true;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(
      new Headers(init?.headers).get("x-wovn-visibility"),
      "private",
    );
    if (outage) return new Response("offline", { status: 503 });
    seen.push({ url: String(input), body: String(init?.body) });
    return new Response("ok");
  };
  const report = (root: string, home: string) =>
    publish(root, home, "https://example.invalid", fetcher);
  const result = await sync({ ...f.options, report, commit: "a".repeat(40) });
  assert.equal(result.attempt?.outcome, "success");
  assert.equal((await readdir(join(f.root, "outbox"))).length, 1);
  outage = false;
  await sync({ ...f.options, report, commit: "a".repeat(40) });
  assert.equal((await readdir(join(f.root, "outbox"))).length, 0);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].url.endsWith(".log"));
  const status = reportSchema.parse(JSON.parse(seen[1].body));
  assert.equal(status.installed?.commit, "a".repeat(40));
  assert.equal(status.changes[0]?.name, "example");
});

test("publishing a backlog uploads logs then only the newest status", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  await sync({ ...f.options, commit: "a".repeat(40) });
  await sync({ ...f.options, commit: "b".repeat(40) });
  const tokenDir = join(f.home, ".config/wovn-files");
  await mkdir(tokenDir, { recursive: true });
  await writeFile(join(tokenDir, "token.txt"), "test-token");
  const calls: string[] = [];
  await publish(
    f.root,
    f.home,
    "https://example.invalid",
    async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("status.json"))
        assert.equal(
          JSON.parse(String(init?.body)).installed.commit,
          "b".repeat(40),
        );
      return new Response("ok");
    },
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.at(-1)?.endsWith("status.json"));
});

test("lock prevents overlapping runs and permits the next run", async (t) => {
  const f = await fixture(t);
  let count = 0;
  await withLock(f.root, async () => {
    count++;
    assert.equal(
      await withLock(f.root, async () => {
        count++;
      }),
      false,
    );
  });
  assert.equal(count, 1);
  assert.equal(
    await withLock(f.root, async () => {
      count++;
    }),
    true,
  );
  assert.equal(count, 2);
});

test("LaunchAgent runs at login and every five minutes with escaped absolute paths", () => {
  const xml = launchAgent(
    "/node & tools/node",
    "/test/launcher.mjs",
    "/test/log",
  );
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<integer>300<\/integer>/);
  assert.match(xml, /node &amp; tools/);
});

test("new targeting metadata can adopt identical legacy contents and remove a shared copy", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  install((await readSkills(f.checkout))[0], f.home);
  await f.skill("example", "claude-code");
  const state = await sync({ ...f.options, commit: "a".repeat(40) });
  assert.equal(state.attempt?.outcome, "success", state.attempt?.error ?? "");
  assert.equal(await exists(join(f.home, ".agents/skills/example")), null);
  assert.equal(
    (await exists(join(f.home, ".claude/skills/example")))?.isDirectory(),
    true,
  );
});

test("all archived skills are removed when the live collection is empty", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  await sync({ ...f.options, commit: "a".repeat(40) });
  await rm(join(f.checkout, "skills/example"), { recursive: true });
  const state = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(state.attempt?.outcome, "success", state.attempt?.error ?? "");
  assert.equal(state.managed.length, 0);
  assert.equal(await exists(join(f.home, ".agents/skills/example")), null);
});

test("external edits to an owned installation are reported before mutation", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  await sync({ ...f.options, commit: "a".repeat(40) });
  const path = join(f.home, ".agents/skills/example/SKILL.md");
  await writeFile(path, "local edit");
  const state = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(state.attempt?.outcome, "failed");
  assert.match(state.attempt?.error ?? "", /changed outside/);
  assert.equal(await readFile(path, "utf8"), "local edit");
});

test("crash recovery preserves the interrupted attempt's report", async (t) => {
  const f = await fixture(t);
  await f.skill("example");
  await sync({ ...f.options, commit: "a".repeat(40) });
  const state = await json(join(f.root, "state.json"), stateSchema);
  assert.ok(state.attempt);
  state.attempt.outcome = "running";
  state.attempt.finishedAt = null;
  state.pending = state.managed;
  await atomic(join(f.root, "state.json"), state);
  const result = await sync({ ...f.options, commit: "b".repeat(40) });
  assert.equal(result.attempt?.outcome, "success");
  const oldReport = await json(
    join(f.root, "outbox", `${state.attempt.id}.json`),
    reportSchema,
  );
  assert.equal(oldReport.attempt.outcome, "partial");
});

test("stale launcher lock is recovered, but a surviving runtime keeps it held", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "sync.lock"), "2147483647");
  await writeFile(join(f.root, "sync.child"), String(process.pid));
  assert.equal(
    await withLock(f.root, async () => {
      throw new Error("must not enter");
    }),
    false,
  );
  await rm(join(f.root, "sync.child"));
  assert.equal(await withLock(f.root, async () => {}), true);
});

test("launcher fetches remote main in its own checkout and runs the new runtime", async (t) => {
  const { cp, chmod } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const f = await fixture(t);
  const project = fileURLToPath(new URL("../", import.meta.url));
  await cp(join(project, "scripts"), join(f.checkout, "scripts"), {
    recursive: true,
  });
  await cp(join(project, "package.json"), join(f.checkout, "package.json"));
  await f.skill("first");
  function git(...args: string[]) {
    const result = spawnSync("git", args, {
      cwd: f.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-b", "main");
  git("config", "user.name", "Fleet Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-m", "Initial fixture");
  const firstCommit = git("rev-parse", "HEAD");
  // Dependency provisioning is local and deterministic; all installer calls remain real.
  const provision = join(f.root, "pnpm-test");
  await writeFile(
    provision,
    `#!${process.execPath}\nconst fs = require('node:fs');\ntry { fs.symlinkSync(${JSON.stringify(join(project, "node_modules"))}, 'node_modules', 'dir'); } catch(e) { if(e.code !== 'EEXIST') throw e; }\n`,
  );
  await chmod(provision, 0o700);
  await atomic(join(f.root, "config.json"), { ...f.config, pnpm: provision });
  function launchTest() {
    const code = `import { launch } from ${JSON.stringify(new URL("../scripts/fleet/launcher.mjs", import.meta.url).href)}; await launch(${JSON.stringify(f.root)}, ${JSON.stringify(f.checkout)});`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      {
        cwd: f.root,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: f.home },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  launchTest();
  assert.equal(
    (await json(join(f.root, "state.json"), stateSchema)).installed?.commit,
    firstCommit,
  );
  assert.ok(await exists(join(f.root, "launcher.mjs")));
  await rm(join(f.checkout, "skills/first"), { recursive: true });
  await f.skill("second");
  git("add", ".");
  git("commit", "-m", "Rename fixture");
  launchTest();
  assert.equal(
    (await json(join(f.root, "state.json"), stateSchema)).installed?.commit,
    git("rev-parse", "HEAD"),
  );
  assert.equal(await exists(join(f.home, ".agents/skills/first")), null);
  assert.ok(await exists(join(f.home, ".agents/skills/second")));
  assert.equal(await exists(join(f.root, "sync.lock")), null);
});
