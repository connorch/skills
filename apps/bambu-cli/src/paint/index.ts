import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Command } from "commander";
import type { Config } from "../config.ts";
import { EXIT_FAILED, EXIT_USAGE, next, output } from "../cli.ts";
import type { Slot } from "../printer/report.ts";
import { fetchStatus } from "../printer/index.ts";
import { loadColouredModel, ModelLoadError, NoColourError, type ColouredModel } from "./load.ts";
import { ColorsLostError, paintModel, validateOptions } from "./pipeline.ts";
import { buildProject } from "./project.ts";
import { deltaE2000, parseHex, srgbToLab } from "./lab.ts";
import { filamentCatalogue, nearestFilaments } from "./filaments.ts";
export * from "./lab.ts";
export * from "./palette.ts";
export * from "./load.ts";
export * from "./segment.ts";
export * from "./sampling.ts";
export * from "./project.ts";
export * from "./filaments.ts";
export * from "./pipeline.ts";
export interface PaintCommandOptions {
  output?: string;
  maxColors?: string;
  colors?: string;
  minArea?: string;
  minPct?: string;
  height?: string;
  smooth?: string;
  finish?: string;
  ams?: boolean;
  json?: boolean;
}
export interface PaintDependencies {
  load: (path: string) => Promise<ColouredModel>;
  status: (config: Config) => Promise<{ trays: Slot[] }>;
  write: (path: string, data: Uint8Array) => Promise<void>;
  stderr: (message: string) => void;
}
export const defaultDependencies: PaintDependencies = {
  load: loadColouredModel,
  status: fetchStatus,
  // Written beside the destination and renamed, so a failed repaint keeps the old project.
  write: async (path: string, data: Uint8Array) => {
    await writeFile(`${path}.tmp`, data);
    await rename(`${path}.tmp`, path);
  },
  stderr: (message: string) => console.error(message),
};
// Injectable command boundary: offline callers supply Models, Slots and a file sink.
// The filament type the painted project is written for (its profiles and temperatures).
export const PROJECT_MATERIAL = "PLA";

export async function runPaint(
  path: string,
  options: PaintCommandOptions,
  config: Config,
  deps: PaintDependencies = defaultDependencies,
) {
  if (options.minArea !== undefined && options.minPct !== undefined)
    throw new RangeError("use --min-area or --min-pct, not both");
  const settings = {
    maxColors: Number(options.maxColors ?? 4),
    minArea:
      options.minPct !== undefined
        ? Number(options.minPct) / 100
        : Number(options.minArea ?? 0.002),
    height: options.height === undefined ? undefined : Number(options.height),
    smooth: Number(options.smooth ?? 1),
    colors:
      options.colors === undefined
        ? undefined
        : options.colors
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
  };
  validateOptions(settings);
  const catalogue = filamentCatalogue(options.finish);
  const model = await deps.load(path);
  let slots: Slot[] = [];
  if (options.colors === undefined && options.ams !== false) {
    try {
      // The project is written with PLA profiles and temperatures, so only
      // PLA Slots can be the Palette; a PETG match would print PETG as PLA.
      const trays = (await deps.status(config)).trays;
      slots = trays.filter((s) => s.color && s.material.toUpperCase() === PROJECT_MATERIAL);
      if (!slots.length)
        deps.stderr(
          `bambu: no loaded ${PROJECT_MATERIAL} Slot has a colour; using a detected Palette`,
        );
      else if (slots.length < trays.filter((s) => s.color).length)
        deps.stderr(`bambu: only ${PROJECT_MATERIAL} Slots are used for the Palette`);
    } catch (error) {
      deps.stderr(
        `bambu: printer unreachable: ${error instanceof Error ? error.message : String(error)}; using a detected Palette`,
      );
    }
  }
  const result = paintModel(model, { ...settings, slots }),
    stem = basename(path, extname(path)),
    target = resolve(options.output ?? join(dirname(path), `${stem}_painted.3mf`));
  if (target === resolve(path)) throw new RangeError("the output must not be the input Model");
  if (extname(target).toLowerCase() !== ".3mf")
    throw new RangeError("the output must be a .3mf file");
  try {
    await deps.write(
      target,
      buildProject(
        result.vertices,
        result.faces,
        result.labels,
        result.palette.hex,
        stem,
        config.settings().model ?? "P1S",
      ),
    );
  } catch (error) {
    throw new Error(
      `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const matches = nearestFilaments(result.palette.hex, catalogue);
  return {
    output_file: target,
    size_mm: result.sizeMm.map((v) => Math.round(v * 100) / 100),
    metric: "CIEDE2000" as const,
    warnings: result.warnings,
    colors: result.palette.hex.map((hex, i) => ({
      hex,
      area_pct: Math.round(result.areaShare[i]! * 10000) / 100,
      ...(result.slotMatches[i]
        ? { slot: result.slotMatches[i]!.slot }
        : { suggested_filament: matches[i] }),
    })),
  };
}
export function formatReport(report: Awaited<ReturnType<typeof runPaint>>): string {
  const lines = report.colors.map((c, i) => {
    const match = "slot" in c ? c.slot : undefined,
      suggested = "suggested_filament" in c ? c.suggested_filament : undefined;
    const hint = match
      ? ` → ${match.label} ${match.material} ${match.name} (ΔE ${deltaE2000(srgbToLab(parseHex(c.hex)), srgbToLab(parseHex(match.hex))).toFixed(1)})`
      : suggested
        ? ` → ${suggested.line} ${suggested.name} (ΔE ${suggested.delta_e})`
        : "";
    return `${i + 1}  ${c.hex}  ${c.area_pct} %${hint}`;
  });
  return [
    `${report.size_mm.join(" x ")} mm, ${report.metric}`,
    ...lines,
    ...report.warnings,
    next(`Use this file: ${report.output_file}`),
  ].join("\n");
}
// Add paint commands only; the CLI owner registers this module on the shared program.
export function register(
  program: Command,
  config: Config,
  deps: PaintDependencies = defaultDependencies,
): void {
  program
    .command("paint <model>")
    .description("paint a Model for multi-colour AMS printing")
    .option("-o, --output <file>")
    .option("--max-colors <N>", "maximum Palette size", "4")
    .option("--colors <hexes>")
    .option("--min-area <fraction>")
    .option("--min-pct <percent>")
    .option("--height <mm>")
    .option("--smooth <N>", "smoothing passes", "1")
    .option("--finish <finishes>", "allowed filament finishes", "opaque,matte")
    .option("--no-ams")
    .option("--json")
    .action(async (path: string, options: PaintCommandOptions) => {
      try {
        const report = await runPaint(path, options, config, deps);
        output(Boolean(options.json), report, () => formatReport(report));
        if (options.json) for (const warning of report.warnings) console.error(warning);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error),
          missing = error instanceof ModelLoadError && message.startsWith("file not found:");
        const type =
          error instanceof RangeError
            ? "bad_arguments"
            : missing
              ? "not_found"
              : error instanceof NoColourError
                ? "no_colour"
                : error instanceof ColorsLostError
                  ? "colors_lost"
                  : error instanceof ModelLoadError
                    ? "unreadable"
                    : message.startsWith("could not write")
                      ? "write_failed"
                      : "failed";
        if (options.json)
          output(
            true,
            {
              error: {
                type,
                message,
                ...(error instanceof ColorsLostError ? { lost: error.lost, kept: error.kept } : {}),
              },
            },
            () => "",
          );
        console.error(`bambu: ${message}`);
        process.exitCode = type === "bad_arguments" || missing ? EXIT_USAGE : EXIT_FAILED;
      }
    });
}
export * from "./obj.ts";
