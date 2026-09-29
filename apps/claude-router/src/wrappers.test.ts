import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Config } from "./config.ts";
import { installWrappers } from "./wrappers.ts";

describe("wrappers", () => {
  it("writes one executable per account that forces it by header", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-router-bin-"));
    const paths = installWrappers(["work", "personal_2"], dir);
    expect(paths).toEqual([join(dir, "claude-work"), join(dir, "claude-personal_2")]);
    expect(statSync(join(dir, "claude-work")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, "claude-personal_2"), "utf8")).toContain(
      'ANTHROPIC_CUSTOM_HEADERS="x-claude-router-account: personal_2" exec claude "$@"',
    );
    // A label that is gone loses its wrapper; a user's own claude-* file stays.
    writeFileSync(join(dir, "claude-mine"), "#!/bin/sh\necho mine\n");
    installWrappers(["work"], dir);
    expect(existsSync(join(dir, "claude-personal_2"))).toBe(false);
    expect(existsSync(join(dir, "claude-mine"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects labels that would not make a safe command or would shadow one", () => {
    expect(() => Config.parse({ accounts: ["work", "router"] })).toThrow();
    expect(() => Config.parse({ accounts: ["Router"] })).toThrow();
    expect(() => Config.parse({ accounts: ["work", "Work"] })).toThrow();
    expect(() => Config.parse({ accounts: ["direct"] })).toThrow();
    expect(() => Config.parse({ accounts: ['a"; rm -rf ~'] })).toThrow();
    expect(Config.parse({ accounts: ["team-2", "personal_2"] }).accounts).toHaveLength(2);
  });
});
