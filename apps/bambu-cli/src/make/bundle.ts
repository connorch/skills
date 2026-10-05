import { readFileSync } from "node:fs";

// Inline the official WASM so the installed CLI needs no adjacent files or node_modules.
export function bundleManifoldWasm() {
  return {
    name: "bambu-make-wasm",
    load(id: string) {
      if (!id.replaceAll("\\", "/").endsWith("/make/wasm.ts")) return;
      const binary = readFileSync(
        new URL(import.meta.resolve("manifold-3d/manifold.wasm")),
      ).toString("base64");
      return `export function wasmBinary() { return Buffer.from(${JSON.stringify(binary)}, "base64"); }`;
    },
  };
}
