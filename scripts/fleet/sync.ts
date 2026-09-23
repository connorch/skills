import {
  appendFile,
  mkdir,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  atomic,
  emptyState,
  exists,
  fingerprint,
  json,
  safePath,
  stateSchema,
  slug,
  type Config,
} from "./files.ts";
import {
  cliVersion,
  install,
  installedSkills,
  preview,
  readSkills,
} from "./installer.ts";
import {
  completeReport,
  publish,
  queueReport,
  type Report,
} from "./reports.ts";

const lockSchema = z.object({
  skills: z.record(
    z.string(),
    z.object({ source: z.string(), sourceType: z.string() }).passthrough(),
  ),
});

export async function sync(options: {
  root: string;
  home: string;
  checkout: string;
  commit: string;
  config: Config;
  installSkill?: typeof install;
  report?: typeof publish;
}) {
  const { root, home, checkout, commit, config } = options;
  const stateFile = join(root, "state.json");
  const state = await json(stateFile, stateSchema, emptyState());
  const reporter = options.report ?? publish;
  async function send() {
    try {
      await reporter(root, home);
      await atomic(join(root, "reporting.json"), { error: null });
    } catch (error) {
      await atomic(join(root, "reporting.json"), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Recover a report if the process stopped between saving its result and queueing it.
  if (state.attempt && state.attempt.outcome !== "running") {
    const published = await json(
      join(root, "reported.json"),
      z.string().nullable(),
      null,
    );
    if (
      published !== state.attempt.id &&
      !(await exists(join(root, "outbox", `${state.attempt.id}.json`)))
    )
      await queueReport(
        root,
        completeReport(config.machine, cliVersion, state, []),
      );
  }
  if (
    state.installed?.commit === commit &&
    !state.pending.length &&
    state.attempt?.outcome === "success"
  ) {
    await send();
    if (
      !(await exists(join(root, "outbox"))) ||
      !(await readdir(join(root, "outbox"))).length
    ) {
      await atomic(join(root, "reported.json"), state.attempt.id);
    }
    return state;
  }
  const now = new Date().toISOString();
  const id = `${now.replace(/[:.]/g, "-")}-${randomUUID()}`;
  if (state.attempt?.outcome === "running") {
    state.attempt.outcome = "partial";
    state.attempt.finishedAt = now;
    state.attempt.error =
      "Previous sync was interrupted; retrying reconciliation";
    await queueReport(
      root,
      completeReport(config.machine, cliVersion, state, []),
    );
  }
  state.attempt = {
    id,
    commit,
    startedAt: now,
    finishedAt: null,
    outcome: "running",
    error: null,
    cliVersion,
    logKey: `skills-fleet/${config.machine}/logs/${id}.log`,
  };
  await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
  const log = join(root, "logs", `${id}.log`);
  await writeFile(
    log,
    `Machine: ${config.machine}\nCommit: ${commit}\nSkills CLI: ${cliVersion}\n`,
    { mode: 0o600 },
  );
  await atomic(stateFile, state);
  const changes: Report["changes"] = [];
  let mutating = false;
  try {
    const skills = await readSkills(checkout);
    const desired = await preview(skills);
    const owned = new Map(state.managed.map((item) => [item.path, item]));
    const interrupted = new Set(state.pending.map((item) => item.path));
    for (const item of state.pending)
      if (!owned.has(item.path)) owned.set(item.path, item);
    const known = new Map(desired.map((item) => [item.path, item]));
    const lockPath = join(home, ".agents", ".skill-lock.json");
    const locked = (await exists(lockPath))
      ? await json(lockPath, lockSchema)
      : { skills: {} };
    const provenNames = new Set(
      Object.entries(locked.skills)
        .filter(
          ([name, entry]) =>
            slug.safeParse(name).success &&
            entry.source === "connorch/skills" &&
            entry.sourceType === "github",
        )
        .map(([name]) => name),
    );
    const discovered = installedSkills(home);
    const relevantNames = new Set([
      ...skills.map((s) => s.name),
      ...state.managed.map((p) => p.name),
      ...provenNames,
    ]);
    // Include CLI-discovered legacy roots, including copies in older harness directories.
    const roots = new Set([
      ...desired.map((p) => dirname(p.path)),
      ...discovered.map((p) => relative(home, dirname(p.path))),
    ]);
    for (const name of relevantNames)
      for (const parent of roots) {
        const path = join(parent, name);
        if (!known.has(path) && !owned.has(path)) {
          const full = await safePath(home, path);
          const digest = await fingerprint(full);
          if (digest) known.set(path, { name, path, fingerprint: digest });
        }
      }
    for (const item of [...owned.values(), ...known.values()]) {
      const path = await safePath(home, item.path);
      const actual = await fingerprint(path);
      if (!actual) continue;
      const previous = owned.get(item.path);
      if (previous) {
        if (actual !== previous.fingerprint && !interrupted.has(item.path)) {
          throw new Error(
            `Managed skill changed outside fleet sync: ${item.path}. Move it aside before retrying.`,
          );
        }
        owned.set(item.path, { ...previous, fingerprint: actual });
      } else {
        const expected = desired.find((p) => p.path === item.path);
        const contentPath = (await exists(path))?.isSymbolicLink()
          ? await safePath(
              home,
              relative(home, resolve(dirname(path), await readlink(path))),
            )
          : path;
        const normalized = await fingerprint(contentPath, true);
        const sameContent = desired.some(
          (candidate) =>
            candidate.name === item.name &&
            candidate.adoptionFingerprint === normalized,
        );
        if (
          !provenNames.has(item.name) &&
          actual !== expected?.fingerprint &&
          !sameContent
        ) {
          throw new Error(
            `Cannot establish ownership of ${item.path}. Move it aside before retrying; no installed skills changed.`,
          );
        }
        owned.set(item.path, { ...item, fingerprint: actual });
      }
    }
    state.managed = [...owned.values()];
    // Save all authorized destinations before mutation, including possible partial CLI output.
    state.pending = desired;
    await atomic(stateFile, state);
    for (const skill of skills) {
      const expected = desired.filter((p) => p.name === skill.name);
      mutating = true;
      const output = (options.installSkill ?? install)(skill, home);
      await appendFile(
        log,
        `\nInstall ${skill.name} -> ${skill.agents.join(", ")}\n${output}\n`,
      );
      for (const item of expected) {
        if (
          (await fingerprint(await safePath(home, item.path))) !==
          item.fingerprint
        ) {
          throw new Error(
            `CLI did not produce the expected installation: ${item.path}`,
          );
        }
      }
      changes.push({
        name: skill.name,
        action: "install",
        agents: skill.agents,
      });
    }
    const wantedPaths = new Set(desired.map((p) => p.path));
    for (const item of owned.values()) {
      if (wantedPaths.has(item.path)) continue;
      const path = await safePath(home, item.path);
      const current = await fingerprint(path);
      if (current && current !== item.fingerprint) {
        throw new Error(
          `Skill changed during sync; refusing to remove ${item.path}`,
        );
      }
      mutating = true;
      await rm(path, { recursive: true, force: true });
      await appendFile(log, `Remove ${item.path}\n`);
      changes.push({ name: item.name, action: "remove", agents: [] });
    }
    state.managed = desired;
    state.pending = [];
    state.installed = { commit, at: new Date().toISOString() };
    state.attempt.outcome = "success";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.attempt.error = message;
    state.attempt.outcome = mutating ? "partial" : "failed";
    await appendFile(log, `\n${state.attempt.outcome}: ${message}\n`);
  }
  state.attempt.finishedAt = new Date().toISOString();
  await atomic(stateFile, state);
  await queueReport(
    root,
    completeReport(config.machine, cliVersion, state, changes),
  );
  await send();
  if (!(await readdir(join(root, "outbox"))).length)
    await atomic(join(root, "reported.json"), id);
  return state;
}
