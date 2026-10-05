import { Command, InvalidArgumentError, Option } from "commander";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { EXIT_FAILED, EXIT_USAGE, next, output } from "../cli.ts";
import { findCli, findProfilesDir } from "./discovery.ts";
import { ProfileError, ProfileLibrary, number } from "./profiles.ts";
import {
  compatible,
  findFilament,
  findMachine,
  findProcess,
  layerHeights,
  machinesByNozzle,
  materialTypes,
  PRINTER_FAMILIES,
  printerKey,
  QUALITIES,
  ResolveError,
  resolveProfiles,
  type ProfileChoice,
} from "./resolve.ts";
import {
  checkModel,
  checkOutput,
  PLATES,
  ResolveModelError,
  runSlice,
  type SliceResult,
} from "./runner.ts";
export * from "./discovery.ts";
export * from "./profiles.ts";
export * from "./resolve.ts";
export * from "./estimate.ts";
export * from "./runner.ts";
export const INSTALL_HINT =
  "Bambu Studio not found. Install it from https://bambulab.com/en/download/studio (02.05.02 or newer) and start it once. Set BAMBU_STUDIO_CLI to its executable and BAMBU_STUDIO_PROFILES to the folder holding BBL.json for an unusual installation.";
const REMOVED_FLAGS: Record<string, string> = {
  "--filament":
    "`--filament` was renamed to `--material`. Pass a type or a Bambu Studio filament name.",
  "--orient": "slice no longer re-orients Models. Choose the orientation before slicing.",
  "--arrange": "slice no longer arranges the Plate. A 3MF keeps its own arrangement.",
  "--no-detect":
    "slice no longer asks the printer what it is. Use --printer or bambu config set model P1S.",
};
export function removedOption(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = (argv[index] ?? "").split("=", 2);
    const value = inline ?? argv[index + 1];
    if (flag && REMOVED_FLAGS[flag]) return REMOVED_FLAGS[flag];
    if (flag === "--quality" && value?.toLowerCase() === "extra")
      return "`--quality extra` was removed. Use draft, standard or fine, or --layer-height 0.08 (see --list-profiles).";
  }
  return undefined;
}
export function millimetres(value: string): number {
  const parsed = Number(value.toLowerCase().replace(/mm$/, "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new InvalidArgumentError("must be a size greater than 0 in mm");
  return parsed;
}
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
export function outputPath(model: string, requested?: string): string {
  const expand = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  return requested
    ? resolve(expand(requested))
    : join(dirname(model), `${basename(model, extname(model))}_sliced.3mf`);
}
export function printerOptions(library: ProfileLibrary, printer: string, nozzle: number) {
  const family = PRINTER_FAMILIES[printer];
  if (!family) throw new ResolveError(`Unknown printer '${printer}'`);
  const machine = findMachine(library, family, nozzle);
  return {
    printer,
    machine_profile: machine[0],
    qualities: Object.fromEntries(QUALITIES.map((q) => [q, findProcess(library, machine, q)[0]])),
    layer_heights_mm: layerHeights(compatible(library, "process", machine[0])),
    materials: materialTypes(compatible(library, "filament", machine[0])),
    default_filament: findFilament(library, machine)[0],
  };
}
export function listProfiles(library: ProfileLibrary, printer?: string, nozzle = 0.4) {
  return {
    schema: 1,
    profiles_dir: library.root,
    profiles_version: library.version,
    printers: Object.entries(PRINTER_FAMILIES).map(([printer, family]) => ({
      printer,
      machine_family: family,
      nozzles_mm: machinesByNozzle(library, family).map(
        ([, p]) => number(p, "printer_variant") ?? 0,
      ),
    })),
    qualities: QUALITIES,
    selected: printer ? printerOptions(library, printer, nozzle) : null,
  };
}
export function sliceReport(
  choice: ProfileChoice,
  result: SliceResult,
  model: string,
  cli: string[],
  library: ProfileLibrary,
) {
  const estimate = result.estimate;
  return {
    schema: 1,
    output_file: result.output_file,
    input_file: model,
    printer: choice.printer,
    nozzle_mm: Number(choice.nozzle),
    layer_height_mm: choice.layer_height_mm,
    material: choice.material,
    machine_profile: choice.machine,
    process_profile: choice.process,
    filament_profiles: [choice.filament],
    plate: choice.bed_type || null,
    print_time_s: Math.round(estimate.print_time_s),
    print_time_includes_start_sequence: true,
    filament_g: Number(estimate.filament_g.toFixed(2)),
    filaments: estimate.filaments.map((use) => ({
      ...use,
      grams: Number(use.grams.toFixed(2)),
      profile: use.slot === 1 ? choice.filament : null,
    })),
    plates: estimate.plates,
    plate_summaries: result.plate_summaries,
    estimate_source: estimate.source,
    warnings: estimate.warnings,
    bambu_studio: {
      version: result.bambu_studio_version,
      cli: cli.join(" "),
      profiles_dir: library.root,
      profiles_version: library.version,
    },
    slice_seconds: Number(result.seconds.toFixed(2)),
  };
}
export function printSlice(choice: ProfileChoice, result: SliceResult): string {
  return [
    `${choice.printer} · ${choice.nozzle} mm nozzle · ${choice.layer_height_mm} mm layers · ${choice.material}`,
    `Profiles: ${choice.machine} | ${choice.process} | ${choice.filament}`,
    `Plate: ${choice.bed_type}`,
    `Sliced with Bambu Studio${result.bambu_studio_version ? ` ${result.bambu_studio_version}` : ""} in ${result.seconds.toFixed(1)} s`,
    ...result.estimate.warnings,
    ...result.plate_summaries.map(
      (p) =>
        `plate ${p.id}: ${p.filament_g.toFixed(1)} g, ${choice.bed_type} at ${p.bed_temp_c}C (preview ${p.preview})`,
    ),
    `≈ ${formatDuration(result.estimate.print_time_s)} incl. start sequence · ${result.estimate.filament_g.toFixed(1)} g ${choice.material}`,
    next(`Use this file: ${result.output_file}`),
  ].join("\n");
}
const optionsSchema = z.object({
  printer: z.string().optional(),
  nozzle: z.number(),
  material: z.string().optional(),
  quality: z.enum(QUALITIES).optional(),
  layerHeight: z.number().optional(),
  output: z.string().optional(),
  plate: z.enum(["textured", "cool", "engineering", "high-temp"]),
  timeout: z.number(),
  listProfiles: z.boolean().default(false),
  json: z.boolean().default(false),
});
export const commandDependencies = {
  findCli,
  findProfilesDir,
  library: (root: string) => new ProfileLibrary(root),
  runSlice,
  checkModel,
  checkOutput,
};
// Register the isolated slicer command; dependencies can be replaced by offline fixtures.
export function register(
  program: Command,
  config: Config,
  dependencies = commandDependencies,
): void {
  program
    .command("slice [model]")
    .description("slice a Model with Bambu Studio and report time and filament")
    .option("-o, --output <out.3mf>", "sliced 3MF to write")
    .option("--printer <model>", "printer model")
    .option("--nozzle <mm>", "nozzle diameter", millimetres, 0.4)
    .option("--material <material>", "filament type or Bambu Studio name")
    .addOption(
      new Option("--quality <quality>", "print quality")
        .argParser((value: string) => {
          const removed = removedOption(["--quality", value]);
          if (removed) throw new InvalidArgumentError(removed);
          if (!QUALITIES.some((q) => q === value))
            throw new InvalidArgumentError(`Use one of: ${QUALITIES.join(", ")}`);
          return value;
        })
        .conflicts("layerHeight"),
    )
    .option("--layer-height <mm>", "exact preset layer height", millimetres)
    .addOption(
      new Option("--plate <type>", "build Plate").choices(Object.keys(PLATES)).default("textured"),
    )
    .option("--timeout <seconds>", "slicing timeout", millimetres, 300)
    .option("--list-profiles", "list installed presets")
    .option("--json", "one JSON document")
    .addOption(new Option("--filament <name>").hideHelp())
    .addOption(new Option("--orient [value]").hideHelp())
    .addOption(new Option("--arrange [value]").hideHelp())
    .addOption(new Option("--no-detect").hideHelp())
    .action((model: string | undefined, raw: unknown, command: Command) => {
      const options = optionsSchema.parse(raw);
      const reportError = (message: string, code: number, kind: string) => {
        if (options.json) output(true, { error: { type: kind, message } }, () => message);
        console.error(`bambu: ${message}`);
        process.exitCode = code;
      };
      try {
        const removed = removedOption(
          ["filament", "orient", "arrange"]
            .filter((key) => command.getOptionValue(key) !== undefined)
            .map((key) => `--${key}`)
            .concat(command.getOptionValue("detect") === false ? ["--no-detect"] : []),
        );
        if (removed) throw new ResolveModelError(removed, "bad_arguments");
        let input: string | undefined;
        let target: string | undefined;
        if (!options.listProfiles) {
          if (!model)
            throw new ResolveModelError(
              "give a Model file to slice, or --list-profiles",
              "bad_arguments",
            );
          input = resolve(model.startsWith("~/") ? join(homedir(), model.slice(2)) : model);
          dependencies.checkModel(input);
          target = outputPath(input, options.output);
          dependencies.checkOutput(input, target);
        }
        const requested = options.printer || config.settings().model;
        const printer = requested ? printerKey(requested) : undefined;
        if (requested && !printer)
          throw new ResolveModelError(
            `Unknown printer '${requested}'. Use one of: ${Object.keys(PRINTER_FAMILIES).join(", ")}`,
            "unknown_printer",
          );
        if (!printer && !options.listProfiles)
          throw new ResolveModelError(
            `No printer given and none configured. Pass --printer (${Object.keys(PRINTER_FAMILIES).join(", ")}) or run: bambu config set model <model>`,
            "not_configured",
          );
        const cli = dependencies.findCli();
        const root = dependencies.findProfilesDir(cli);
        if (!cli || !root) {
          reportError(INSTALL_HINT, EXIT_FAILED, "dependency");
          return;
        }
        const library = dependencies.library(root);
        if (options.listProfiles) {
          const doc = listProfiles(library, printer, options.nozzle);
          output(options.json, doc, () =>
            [
              `Bambu Studio profiles ${library.version}: ${root}`,
              ...doc.printers.map(
                (p) => `${p.printer}: ${p.nozzles_mm.join(", ") || "none in this Bambu Studio"}`,
              ),
              ...(doc.selected
                ? [
                    doc.selected.machine_profile,
                    ...Object.entries(doc.selected.qualities).map(
                      ([q, p]) => `--quality ${q}: ${p}`,
                    ),
                    `--layer-height ${doc.selected.layer_heights_mm.join(", ")}`,
                    `--material ${doc.selected.materials.join(", ")}`,
                    `default filament: ${doc.selected.default_filament}`,
                  ]
                : ["Add --printer MODEL to see its qualities and materials."]),
            ].join("\n"),
          );
          return;
        }
        if (!input || !target || !printer) return;
        const choice = {
          ...resolveProfiles(library, {
            printer,
            nozzle_mm: options.nozzle,
            material: options.material,
            quality: options.quality,
            layer_height_mm: options.layerHeight,
          }),
          bed_type: PLATES[options.plate].name,
        };
        const result = dependencies.runSlice(cli, {
          model: input,
          output: target,
          machine: library.flatten("machine", choice.machine),
          process: library.flatten("process", choice.process),
          filament: library.flatten("filament", choice.filament),
          plate: options.plate,
          timeout_s: options.timeout,
        });
        output(options.json, sliceReport(choice, result, input, cli, library), () =>
          printSlice(choice, result),
        );
      } catch (error) {
        const kind =
          error instanceof ResolveModelError
            ? error.kind
            : error instanceof ResolveError
              ? "no_profile"
              : error instanceof ProfileError
                ? "profiles"
                : "slice_failed";
        reportError(
          error instanceof Error ? error.message : String(error),
          error instanceof ResolveModelError || error instanceof ResolveError
            ? EXIT_USAGE
            : EXIT_FAILED,
          kind,
        );
      }
    });
}
