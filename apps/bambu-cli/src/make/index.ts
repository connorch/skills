import { writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Module from "manifold-3d";
import type { Manifold } from "manifold-3d";
import type { Command } from "commander";
import type { Config } from "../config.ts";
import { fail, next, output } from "../cli.ts";
import { createKit } from "./kit.ts";
import { binaryStl, summarize } from "./stl.ts";
import { wasmBinary } from "./wasm.ts";

export { createKit, holePositions, SLIP_FIT_GAP_MM } from "./kit.ts";
export type { Kit, ManifoldToolbox } from "./kit.ts";
export { binaryStl, summarize } from "./stl.ts";

// Initialize a fresh WASM instance for each Make, isolating scripts and quality settings.
export async function initializeKit() {
  const options = { locateFile: () => "manifold.wasm", wasmBinary: wasmBinary() };
  const manifold = await Module(options);
  manifold.setup();
  return createKit(manifold);
}

// Node 24 strips TS types during import; scripts must export a Model-building function.
export async function make(script: string, out?: string) {
  const file = resolve(script);
  if (![".ts", ".js", ".mts", ".mjs"].includes(extname(file)))
    throw new Error("Make scripts must be TypeScript or JavaScript modules");
  const destination = resolve(out ?? file.slice(0, -extname(file).length) + ".stl");
  if (destination === file) throw new Error("Output must differ from the script");
  if (extname(destination).toLowerCase() !== ".stl") throw new Error("Output must be an STL file");
  const scriptModule: { default?: unknown } = await import(pathToFileURL(file).href);
  if (typeof scriptModule.default !== "function")
    throw new Error("Script must export a default function (kit) => Manifold");
  const kit = await initializeKit();
  const model: unknown = await scriptModule.default(kit);
  if (!(model instanceof kit.manifold.Manifold))
    throw new Error("Script must return a Manifold from kit.manifold");
  return writeModel(model, destination);
}

// Validate before touching the destination, including on a failed subtraction.
export async function writeModel(model: Manifold, destination: string) {
  try {
    const summary = summarize(model);
    await writeFile(destination, binaryStl(model));
    return { output: destination, ...summary };
  } finally {
    model.delete();
  }
}

export function register(program: Command, _config: Config): void {
  program
    .command("make")
    .description("make a Model from a TypeScript script (millimetres)")
    .argument("<script>")
    .option("--out <file.stl>", "Output STL (default: beside the script)")
    .option("--json", "Print JSON")
    .action(async (script: string, options: { out?: string; json?: boolean }) => {
      try {
        const summary = await make(script, options.out);
        output(Boolean(options.json), summary, () =>
          [
            `Exported: ${basename(summary.output)}`,
            `  Dimensions: ${summary.dimensions.map((dimension) => dimension.toFixed(2)).join(" x ")} mm`,
            `  Volume: ${summary.volume.toFixed(2)} mm³ | Surface area: ${summary.surface_area.toFixed(2)} mm²`,
            `  Triangles: ${summary.triangles.toLocaleString("en-US")} | Vertices: ${summary.vertices.toLocaleString("en-US")}`,
            "  Watertight: YES (checked: valid, non-empty manifold)",
            ...(summary.bodies > 1
              ? [
                  `  Warning: ${summary.bodies} separate bodies - they don't touch. Check translate/rotate values unless intentional.`,
                ]
              : []),
            next(`Check the Model: ${summary.output}`),
          ].join("\n"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) {
          output(true, { error: message }, () => "");
          process.exitCode = 1;
        } else fail(message);
      }
    });
}
