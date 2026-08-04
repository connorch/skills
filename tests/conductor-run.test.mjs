import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts/conductor-run.mjs");

function dryRun() {
  const result = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split("\n");
}

test("plans local skill installs with codex skills Claude-only and other skills shared", () => {
  const commands = dryRun();

  assert.deepEqual(commands, [
    `skills add ${repoRoot} -g -a claude-code -s codex-implementation codex-review -y`,
    "rm -rf ~/.agents/skills/codex-implementation ~/.agents/skills/codex-review",
    "skills remove -g -a codex -s codex-implementation codex-review -y",
    `skills add ${repoRoot} -g -a claude-code -a codex -s qa-ux-fix-loop qa-ux-plan qa-ux-verify step-back -y`,
  ]);
});
