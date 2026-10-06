import { readFileSync } from "node:fs";

// The pack hook embeds this binary; source execution resolves the installed npm package.
export function wasmBinary() {
  return readFileSync(new URL(import.meta.resolve("manifold-3d/manifold.wasm")));
}
