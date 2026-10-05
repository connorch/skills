import { basename } from "node:path";
import { Command, Option } from "commander";
import type { Config } from "../config.ts";
import { next, output } from "../cli.ts";
import { z } from "zod";
import {
  analyze,
  bounds,
  decideUnits,
  derivedPath,
  diagnose,
  fileIO,
  keepLargestBody,
  load,
  materialProfile,
  materials,
  orientForPrinting,
  printer,
  printerProfile,
  printers,
  repairMesh,
  round,
  save,
  scale,
} from "../mesh/index.ts";
import type { MeshIO, MaterialProfile, PrinterProfile } from "../mesh/index.ts";
export const optionsSchema = z.object({
  printer: z.string().optional(),
  material: z.string().default("PLA"),
  purpose: z.enum(["general", "decorative", "functional"]).default("general"),
  unit: z.enum(["auto", "mm", "cm", "m", "in"]).default("auto"),
  height: z.coerce
    .number()
    .finite()
    .positive("--height must be a positive number of millimetres")
    .optional(),
  orient: z.boolean().default(false),
  repair: z.boolean().default(false),
  autoRepair: z.boolean().default(true),
  keepMain: z.boolean().default(false),
  json: z.boolean().default(false),
});
export type AnalyzeOptions = z.infer<typeof optionsSchema>;
export class UsageError extends Error {}
export function resolvePrinter(
  requested: string | undefined,
  configured: string | undefined,
  notes: string[],
): PrinterProfile | null {
  if (requested) {
    try {
      return printerProfile(printer(requested));
    } catch {
      throw new UsageError(
        `unknown printer '${requested}'. Known: ${printers.map((p) => p.key).join(", ")}`,
      );
    }
  }
  if (configured) {
    try {
      return printerProfile(printer(configured));
    } catch {
      notes.push(
        `Configured printer '${configured}' is not in the printer table, so the build volume and material were not checked. Pass --printer.`,
      );
      return null;
    }
  }
  notes.push("No printer configured: checked against the P1S (pass --printer).");
  return printerProfile(printer("P1S"));
}
export function resolveMaterial(requested: string, notes: string[]): MaterialProfile {
  const name = requested.toUpperCase(),
    found = materials.find((m) => [m.key, ...m.aliases].some((n) => n.toUpperCase() === name));
  if (found) return materialProfile(found, name);
  notes.push(
    `Unknown material '${requested}': used PLA values. Known: ${materials
      .flatMap((m) => [m.key, ...m.aliases])
      .map((n) => n.toUpperCase())
      .join(", ")}.`,
  );
  return materialProfile(materials.find((m) => m.key === "PLA")!);
}
export interface Step {
  summary: string;
  file?: string | null;
  [key: string]: unknown;
}
// Preparation writes each changed Model beside the previous step's file.
export function prepare(file: string, args: AnalyzeOptions, notes: string[], io: MeshIO = fileIO) {
  let mesh = load(file, io),
    current = file;
  const written: string[] = [],
    steps: Record<string, Step> = {};
  const write = (suffix: string) => {
    current = derivedPath(current, suffix);
    save(current, mesh, io);
    written.push(current);
    return current;
  };
  const units = decideUnits(Math.max(...bounds(mesh).extents), {
    declared: mesh.unit,
    requested: args.unit === "auto" ? undefined : args.unit,
  });
  let factor = units.scale,
    reason = `${units.unit} to mm`;
  if (args.height !== undefined && bounds(mesh).extents[2] >= 0.01) {
    factor = args.height / bounds(mesh).extents[2];
    reason = `to ${args.height} mm tall`;
  } else if (args.height !== undefined) notes.push("--height ignored: the model is flat along Z.");
  else if (units.doubtful) notes.push(units.note);
  if (Math.abs(factor - 1) > 1e-9) {
    mesh = scale(mesh, factor);
    steps.scale = {
      factor: round(factor, 6),
      summary: `Scaled x${Number(factor.toPrecision(4))} (${reason}).`,
      file: write("_scaled"),
    };
  }
  const tier = diagnose(mesh).repair_tier;
  if (tier !== "none") {
    if (args.repair || (tier === "minor" && args.autoRepair)) {
      const repair = repairMesh(mesh);
      mesh = repair.mesh;
      steps.repair = {
        applied: true,
        tier,
        summary: repair.changed
          ? `Repaired: ${repair.result.steps.join("; ")}.`
          : "Repair changed nothing.",
        ...repair.result,
        file: repair.changed ? write("_repaired") : null,
      };
      notes.push(...repair.result.notes);
    } else
      steps.repair = {
        applied: false,
        tier,
        summary: `Not repaired: ${tier === "minor" ? "--no-auto-repair was given" : "non-manifold edges need --repair"}.`,
      };
  }
  if (args.keepMain) {
    const kept = keepLargestBody(mesh);
    mesh = kept.mesh;
    steps.keep_main = {
      ...kept.result,
      summary: `--keep-main: ${kept.result.note}.`,
      file: kept.result.removed ? write("_cleaned") : null,
    };
  }
  if (args.orient) {
    const orient = orientForPrinting(mesh);
    mesh = orient.mesh;
    steps.orient = {
      ...orient.result,
      summary: `--orient: ${orient.result.reason}.`,
      file: orient.result.moved ? write("_oriented") : null,
    };
    if (orient.result.rotated && args.height)
      notes.push(
        `--height ${args.height} was applied before --orient turned the model; it now stands ${bounds(mesh).extents[2].toFixed(1)} mm tall on the plate.`,
      );
  }
  return { mesh, steps, units, written };
}
const removedOptions = z.object({
  render: z.boolean().optional(),
  outputDir: z.string().optional(),
  clean: z.boolean().optional(),
  simplify: z.boolean().optional(),
});
const removedReasons = {
  render: "ignored the view direction. Use bambu preview for images.",
  outputDir: "only chose where rendered images went. Derived Models are written next to the input.",
  clean: "did nothing: loose bodies are only ever removed with --keep-main.",
  simplify:
    "switched off a simplification step that never worked. To simplify, use Bambu Studio: right-click the Model, Simplify Model.",
};
export function analyzeFile(
  file: string,
  raw: unknown = {},
  configuredPrinter?: string,
  io: MeshIO = fileIO,
) {
  const removed = removedOptions.safeParse(raw);
  if (removed.success) {
    const { render, outputDir, clean, simplify } = removed.data;
    const key = render
      ? "render"
      : outputDir !== undefined
        ? "outputDir"
        : clean === false
          ? "clean"
          : simplify === false
            ? "simplify"
            : undefined;
    if (key)
      throw new UsageError(
        `analyze ${key === "outputDir" ? "--output-dir" : key === "clean" ? "--no-clean" : key === "simplify" ? "--no-simplify" : "--render"} was removed in v2.1: it ${removedReasons[key]}`,
      );
  }
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw new UsageError(parsed.error.issues.map((i) => i.message).join("; "));
  const args = parsed.data,
    notes: string[] = [];
  try {
    io.read(file);
  } catch {
    throw new UsageError(`file not found: ${file}`);
  }
  const resolvedPrinter = resolvePrinter(args.printer, configuredPrinter, notes),
    material = resolveMaterial(args.material, notes),
    prepared = prepare(file, args, notes, io);
  return {
    schema: 1,
    file,
    output_file: prepared.written.at(-1) ?? file,
    written_files: prepared.written,
    printer: resolvedPrinter?.name ?? null,
    material: material.name,
    purpose: args.purpose,
    units: prepared.units,
    steps: prepared.steps,
    ...analyze(prepared.mesh, { material, printer: resolvedPrinter, purpose: args.purpose }),
    notes,
  };
}
export type PrintabilityReport = ReturnType<typeof analyzeFile>;
export function formatReport(doc: PrintabilityReport): string {
  const g = doc.geometry,
    detail = [
      ...doc.score_rubric.deductions.filter((d) => d.points).map((d) => `${d.check} ${d.points}`),
      ...doc.score_rubric.caps
        .filter((c) => c.applied)
        .map((c) => `capped at ${c.limit}: ${c.rule}`),
    ],
    lines = [
      `${basename(doc.file)}: ${doc.printer ?? "unknown printer"}, ${doc.material}`,
      `Size ${g.dimensions_mm.join(" x ")} mm · ${g.volume_cm3 === null ? "no volume (open mesh)" : `${g.volume_cm3} cm3`} · ${g.triangles.toLocaleString("en-US")} triangles · ${g.bodies} ${g.bodies === 1 ? "body" : "bodies"}`,
      `Score ${doc.score}/10${detail.length ? ` (${detail.join("; ")})` : ""}`,
      "",
      ...doc.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.summary}`),
    ];
  for (const [title, items] of [
    ["Changes", Object.values(doc.steps).map((s) => s.summary)],
    ["Notes", doc.notes],
    ["Suggestions", doc.suggestions],
  ] as const)
    if (items.length) lines.push("", `${title}:`, ...items.map((i) => `  - ${i}`));
  lines.push(
    "",
    "Settings: " +
      Object.entries(doc.print_settings)
        .map(([key, value]) => `${key.replaceAll("_", " ")} ${value}`)
        .join(" · "),
    "",
    next(`Use this file: ${doc.output_file}`),
  );
  return lines.join("\n");
}
export function register(program: Command, config: Config, io: MeshIO = fileIO): void {
  program
    .command("analyze")
    .description("check a Model: the Printability Report, repair, and orientation")
    .argument("<file>", "Model file (.stl, .3mf, .obj, .glb, .gltf)")
    .option("--printer <model>", "printer model (configured model, else P1S)")
    .option("--material <material>", "filament material", "PLA")
    .addOption(
      new Option("--purpose <purpose>", "suggested settings")
        .choices(["general", "decorative", "functional"])
        .default("general"),
    )
    .addOption(
      new Option("--unit <unit>", "coordinate unit")
        .choices(["auto", "mm", "cm", "m", "in"])
        .default("auto"),
    )
    .option("--height <mm>", "uniformly scale to this height")
    .option("--orient", "put the Model on a flat base")
    .option("--repair", "apply minor repair; major defects require Studio")
    .option("--no-auto-repair", "disable automatic minor repair")
    .option("--keep-main", "keep the largest body when it dominates")
    .option("--json", "one JSON document")
    .addOption(new Option("--render").hideHelp())
    .addOption(new Option("--output-dir <dir>").hideHelp())
    .addOption(new Option("--no-clean").hideHelp())
    .addOption(new Option("--no-simplify").hideHelp())
    .action((file: string, raw: unknown) => {
      const args = optionsSchema.safeParse(raw),
        json = args.success
          ? args.data.json
          : typeof raw === "object" && raw !== null && "json" in raw && raw.json === true;
      try {
        const doc = analyzeFile(file, raw, config.settings().model, io);
        output(json, doc, () => formatReport(doc));
        if (json) console.error(next(`Use this file: ${doc.output_file}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error),
          usage = error instanceof UsageError;
        if (json)
          output(true, { error: { type: usage ? "usage" : "file", message } }, () => message);
        console.error(`bambu: ${message}`);
        process.exitCode = usage ? 2 : 1;
      }
    });
}
