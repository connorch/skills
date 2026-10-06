import { readFileSync } from "node:fs";
import { inline } from "../inline.ts";

// Inline the official WASM so the installed CLI needs no adjacent files or node_modules.
export function bundleManifoldWasm() {
  return inline("/make/wasm.ts", () => {
    const binary = readFileSync(new URL(import.meta.resolve("manifold-3d/manifold.wasm")));
    return `export function wasmBinary() { return Buffer.from(${JSON.stringify(binary.toString("base64"))}, "base64"); }`;
  });
}
