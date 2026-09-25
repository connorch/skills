import { describe, expect, it } from "vite-plus/test";
import { skillAgents, SkillFrontmatter, type MachineContext } from "./controls.ts";
import { EMPTY_MANIFEST, nextManifest, planSkills, type Manifest } from "./plan.ts";

const studio: MachineContext = { name: "connors-mac-studio", platform: "darwin", starting: false };

function controls(metadata: object) {
  return SkillFrontmatter.parse({ name: "x", metadata }).metadata;
}

describe("skillAgents", () => {
  it("defaults to Claude Code and Codex on every Machine", () => {
    expect(skillAgents(controls({}), studio)).toEqual(["claude-code", "codex"]);
  });

  it("combines platforms, machines, and fleet with AND", () => {
    expect(skillAgents(controls({ platforms: ["linux"] }), studio)).toEqual([]);
    expect(skillAgents(controls({ machines: ["hermes-agent"] }), studio)).toEqual([]);
    expect(skillAgents(controls({ fleet: false }), studio)).toEqual([]);
    expect(skillAgents(controls({ fleet: false }), { ...studio, starting: true })).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(
      skillAgents(controls({ agents: ["codex"], machines: ["connors-mac-studio"] }), studio),
    ).toEqual(["codex"]);
  });

  it("ignores unrelated metadata and rejects malformed controls", () => {
    expect(controls({ requires: "the wovn CLI" }).agents).toEqual(["claude-code", "codex"]);
    expect(() => controls({ platforms: ["windows"] })).toThrow();
    expect(() => controls({ agents: "codex" })).toThrow();
  });
});

const manifest = (skills: Manifest["skills"]): Manifest => ({ version: 1, skills });
const plan = (
  desired: Record<string, string[]>,
  current: Manifest,
  lock: Record<string, string> = {},
) =>
  planSkills({
    desired: new Map(Object.entries(desired)),
    manifest: current,
    lockSources: new Map(Object.entries(lock)),
    ownSource: "connorch/skills",
  });

describe("planSkills", () => {
  it("removes nothing on a Machine's first Ship", () => {
    const result = plan({ alpha: ["claude-code"], beta: ["claude-code", "codex"] }, EMPTY_MANIFEST);
    expect(result.remove).toEqual([]);
    expect(result.install).toEqual([
      { agents: ["claude-code"], skills: ["alpha"] },
      { agents: ["claude-code", "codex"], skills: ["beta"] },
    ]);
  });

  it("removes skills that no longer ship here, and whole skills that lose an agent", () => {
    const result = plan(
      { kept: ["claude-code"], narrowed: ["claude-code"] },
      manifest({
        kept: ["claude-code"],
        narrowed: ["claude-code", "codex"],
        deleted: ["codex"],
      }),
    );
    expect(result.remove).toEqual(["deleted", "narrowed"]);
    expect(result.install).toEqual([{ agents: ["claude-code"], skills: ["kept", "narrowed"] }]);
  });

  it("never touches a name another source installed", () => {
    const result = plan({ mine: ["codex"], taken: ["codex"] }, manifest({ gone: ["codex"] }), {
      taken: "someone/else",
      gone: "someone/else",
    });
    expect(result.conflicts).toEqual(["taken"]);
    expect(result.forget).toEqual(["gone"]);
    expect(result.remove).toEqual([]);
    expect(result.install).toEqual([{ agents: ["codex"], skills: ["mine"] }]);
  });

  it("reinstalls skills with a lock entry from this repo, clearing the entry", () => {
    const result = plan({ alpha: ["codex"] }, EMPTY_MANIFEST, { alpha: "connorch/skills" });
    expect(result.remove).toEqual(["alpha"]);
    expect(result.install).toEqual([{ agents: ["codex"], skills: ["alpha"] }]);
  });
});

describe("nextManifest", () => {
  const current = manifest({ narrowed: ["claude-code", "codex"], deleted: ["codex"] });
  const result = plan({ narrowed: ["claude-code"] }, current);

  it("records current state once removals and installs succeed", () => {
    expect(nextManifest(current, result, true)).toEqual(manifest({ narrowed: ["claude-code"] }));
  });

  it("keeps entries whose removal failed so the next Ship retries them", () => {
    expect(nextManifest(current, result, false)).toEqual(current);
  });
});
