import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Config } from "../config.ts";
import { HttpClient, register } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(fetcher: typeof fetch, key?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bambu-cli-generate-"));
  dirs.push(dir);
  const config = new Config({
    dir,
    env: {},
    keychain: { read: () => key, write: () => {}, remove: () => {} },
  });
  const program = new Command();
  register(program, config, new HttpClient(fetcher, async () => {}));
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  return { program, stdout, stderr };
}
const offline: typeof fetch = async () => {
  throw new Error("network forbidden");
};
describe("generate command contract", () => {
  it("submit emits exactly one JSON document without exposing the key", async () => {
    const calls: RequestInit[] = [];
    const f: typeof fetch = async (_url, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ result: "abc" }));
    };
    const { program, stdout } = setup(f, "secret-do-not-print");
    await program.parseAsync(["generate", "text", "a box", "--json"], { from: "user" });
    expect(stdout).toHaveBeenCalledTimes(1);
    const doc = JSON.parse(String(stdout.mock.calls[0]![0]));
    expect(doc).toMatchObject({
      status: "submitted",
      task_id: "meshy:text:abc",
      next_command: "bambu generate download meshy:text:abc",
    });
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("secret-do-not-print");
    expect(JSON.parse(String(calls[0]!.body)).prompt).toBe("a box");
  });
  it("missing key is a JSON configuration error with exit 2", async () => {
    const { program, stdout } = setup(offline);
    await program.parseAsync(["generate", "text", "cat", "--json"], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(stdout.mock.calls[0]![0])).error.type).toBe("not_configured");
  });
  it("missing image fails before contacting a provider", async () => {
    const { program, stdout } = setup(offline, "k");
    await program.parseAsync(["generate", "image", "/nonexistent/bambu/image.png", "--json"], {
      from: "user",
    });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(stdout.mock.calls[0]![0])).error.type).toBe("bad_input");
  });
  it("status is read-only and failed download exits 1", async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ status: "FAILED", task_error: { message: "failed" } }));
    };
    const { program, stdout } = setup(fetcher, "k");
    await program.parseAsync(["generate", "status", "meshy:preview:abc", "--json"], {
      from: "user",
    });
    expect(process.exitCode ?? 0).toBe(0);
    await program.parseAsync(["generate", "download", "meshy:preview:abc", "--json"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect(methods).toEqual(["GET", "GET"]);
    expect(stdout).toHaveBeenCalledTimes(2);
  });
  it("ignored image prompt is flagged on stderr", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ result: "image" }));
    const { program, stdout, stderr } = setup(fetcher, "k");
    await program.parseAsync(
      ["generate", "image", "https://example.com/photo.png", "--prompt", "blue", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(String(stdout.mock.calls[0]![0])).prompt_used).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--prompt was not sent"));
  });
  it("invalid timeout and format fail with exit 2", async () => {
    const { program } = setup(offline, "k");
    await program.parseAsync(["generate", "text", "cat", "--timeout", "0", "--json"], {
      from: "user",
    });
    expect(process.exitCode).toBe(2);
    await program.parseAsync(["generate", "text", "cat", "--format", "fbx", "--json"], {
      from: "user",
    });
    expect(process.exitCode).toBe(2);
  });
  it("download error retains requested resume flags", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "bad key" }), { status: 401 });
    const { program, stdout } = setup(fetcher, "k");
    await program.parseAsync(
      ["generate", "download", "meshy:preview:abc", "--format", "stl", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(String(stdout.mock.calls[0]![0])).next_command).toBe(
      "bambu generate download meshy:preview:abc --format stl --no-texture",
    );
  });
});
