import { describe, expect, it, vi } from "vite-plus/test";
import { Command } from "commander";
import { Config } from "../config.ts";
import { register } from "./index.ts";
const config = new Config({
  dir: "/view-test-config-never-written",
  env: {},
  keychain: { read: () => undefined, write: () => {}, remove: () => {} },
});
async function run(args: string[]) {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
    stderr = vi.spyOn(console, "error").mockImplementation(() => {}),
    previous = process.exitCode;
  try {
    const program = new Command();
    register(program, config);
    await program.parseAsync(["view", ...args], { from: "user" });
    return { out: stdout.mock.calls.map((c) => String(c[0])), code: process.exitCode };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = previous;
  }
}
describe("view command errors", () => {
  it("prints one JSON error document under --json", async () => {
    const usage = await run(["/missing.stl", "-o", "/missing.stl", "--json"]);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.out[0]!)).toEqual({
      error: { type: "usage", message: "the page must not be the Model file" },
    });
    const missing = await run(["/missing.stl", "--json", "--no-publish"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toHaveLength(1);
    expect(JSON.parse(missing.out[0]!).error.type).toBe("failed");
  });
});
