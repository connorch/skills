import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { Command } from "commander";
import { NodeIO } from "@gltf-transform/core";
import { Config } from "../config.ts";
import { srgbToLinear } from "../paint/lab.ts";
import { bands, box, glb, png, textured } from "../paint/fixtures/builder.ts";
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

describe("view painted preview", () => {
  it("writes the Palette's vertex colours in linear space, as glTF expects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bambu-view-")),
      model = join(dir, "box.glb"),
      red: [number, number, number] = [200, 30, 30];
    writeFileSync(
      model,
      glb([{ ...box([0.04, 0.04, 0.04]), material: 0 }], [textured(0)], [png(bands([red]))]),
    );
    const result = await run([model, "--no-publish", "--json"]);
    expect(result.code).toBeUndefined();
    const base64 = /<script id="model"[^>]*>([^<]*)<\/script>/.exec(
      readFileSync(join(dir, "review.html"), "utf8"),
    )?.[1];
    const doc = await new NodeIO().readBinary(new Uint8Array(Buffer.from(base64!, "base64")));
    const colors = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("COLOR_0");
    const first = [...colors!.getArray()!.subarray(0, 3)];
    expect(first).toEqual(red.map((v) => expect.closeTo(srgbToLinear(v / 255), 3)));
  });
});
