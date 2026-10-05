// `bambu view <model>`: the Review Page for one Model (docs/adr/0002). Loads
// the Model, runs the Printability Report checks on it as-is, packs a preview
// GLB, fills the viewer template, writes review.html beside the Model, and
// publishes it privately on wovn.

import { writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { next, output } from "../cli.ts";
import type { Config } from "../config.ts";
import { readSource, type Source } from "../job.ts";
import { resolveMaterial, resolvePrinter } from "../analyze/index.ts";
import { analyze, bounds, load, printer as printerTable } from "../mesh/index.ts";
import { buildGlb } from "./glb.ts";
import { renderReviewPage, type Review } from "./page.ts";
import { publish } from "./publish.ts";

type Analysis = ReturnType<typeof analyze>;
type AnalysisCheck = Analysis["checks"][number];

// The short value shown beside each check's label; the summary is its detail.
function shortValue(check: AnalysisCheck): string {
  if (check.status === "skipped") return "Not checked";
  switch (check.id) {
    case "mesh":
      return check.status === "pass" ? "Watertight" : check.status === "warn" ? "Flawed" : "Open";
    case "build_volume":
      return "fits" in check && check.fits
        ? check.status === "warn"
          ? "Fits turned"
          : "Fits"
        : "Too big";
    case "floating_parts":
      return "floating" in check && check.floating ? `${check.floating} floating` : "None";
    case "overhangs":
      return "area_pct" in check ? `${check.area_pct}% past ${check.limit_deg}°` : "";
    case "wall_thickness":
      return "min_mm" in check && check.min_mm !== null ? `${check.min_mm} mm min` : "";
    case "bed_contact":
      return "contact_pct" in check ? `${check.contact_pct}% flat base` : "";
    case "material":
      return check.status === "pass" ? "Suits the printer" : "Mismatch";
    default:
      return "";
  }
}

export function reviewOf(
  analysis: Analysis,
  {
    job,
    file,
    source,
    printerName,
    plate,
  }: {
    job: string;
    file: string;
    source: Source | undefined;
    printerName: string;
    plate: [number, number, number];
  },
): Review {
  const [x = 0, y = 0, z = 0] = analysis.geometry.dimensions_mm;
  const settings = analysis.print_settings;
  const { title, ...credit } = source ?? {};
  return {
    job,
    title: title ?? basename(file, extname(file)),
    model: { file: basename(file), triangles: analysis.geometry.triangles, size: [x, y, z] },
    source: "route" in credit ? credit : undefined,
    printer: { name: printerName, plate },
    report: {
      score: analysis.score,
      checks: analysis.checks.map((c) => ({
        key: c.id,
        label: c.name,
        status:
          c.status === "pass" || c.status === "skipped"
            ? "ok"
            : c.status === "warn"
              ? "warn"
              : "bad",
        value: shortValue(c),
        detail: c.summary,
      })),
    },
    print: {
      settings: [
        ["Layer", settings.layer_height],
        ["Infill", settings.infill],
        ["Walls", settings.walls],
        ["Supports", settings.supports],
        ["Bed", settings.bed_temp],
      ],
    },
  };
}

export function register(program: Command, config: Config): void {
  program
    .command("view")
    .description("Review Page for a Model: review.html beside it, published on wovn")
    .argument("<model>", "STL, 3MF, OBJ, or GLB")
    .option("-o, --output <file>", "page to write (default: review.html beside the Model)")
    .option("--job <name>", "Print Job name (default: the Model's folder)")
    .option("--printer <model>", "printer for the checks (default: the configured model)")
    .option("--material <name>", "filament type for the checks", "PLA")
    .option("--purpose <purpose>", "general, decorative, or functional", "general")
    .option("--no-publish", "write the page but do not upload it")
    .option("--json")
    .action(async (model: string, raw: unknown) => {
      const options = z
        .object({
          output: z.string().optional(),
          job: z.string().optional(),
          printer: z.string().optional(),
          material: z.string(),
          purpose: z.enum(["general", "decorative", "functional"]),
          publish: z.boolean(),
          json: z.boolean().optional(),
        })
        .parse(raw);
      const file = resolve(model);
      const mesh = load(file);
      const notes: string[] = [];
      const printer = resolvePrinter(options.printer, config.settings().model, notes);
      const material = resolveMaterial(options.material, notes);
      for (const note of notes) console.error(note);
      const analysis = analyze(mesh, { material, printer, purpose: options.purpose });
      const [px = 256, py = 256, pz = 256] = printer
        ? printerTable(printer.name).build_volume_mm
        : [];
      const job = options.job ?? basename(dirname(file));
      const review = reviewOf(analysis, {
        job,
        file,
        source: readSource(file),
        printerName: printer?.name ?? "Unknown printer",
        plate: [px, py, pz],
      });
      // Model space is Z-up like the printer; the page expects it resting on z = 0.
      const { min } = bounds(mesh);
      const positions = new Float32Array(mesh.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = mesh.positions[i]! - (min[0] + analysis.geometry.dimensions_mm[0]! / 2);
        positions[i + 1] =
          mesh.positions[i + 1]! - (min[1] + analysis.geometry.dimensions_mm[1]! / 2);
        positions[i + 2] = mesh.positions[i + 2]! - min[2];
      }
      const glb = await buildGlb({ positions, indices: new Uint32Array(mesh.indices) });
      const page = resolve(options.output ?? resolve(dirname(file), "review.html"));
      writeFileSync(page, renderReviewPage(review, glb));
      const url = options.publish ? publish(page, `bambu/${job}/review.html`) : undefined;
      output(Boolean(options.json), { page, url, score: analysis.score, review }, () =>
        [
          `Score ${analysis.score}/10 · ${review.model.size.map((n) => n.toFixed(1)).join(" x ")} mm · ${review.model.triangles.toLocaleString("en-US")} triangles`,
          ...analysis.checks
            .filter((c) => c.status === "warn" || c.status === "fail")
            .map((c) => `${c.status === "fail" ? "FAIL" : "WARN"} ${c.name}: ${c.summary}`),
          `Review Page: ${url ?? page}`,
          next(
            url
              ? `Open ${page} in the browser tools to check it, then send Connor ${url}`
              : `Open ${page} in the browser tools to check it`,
          ),
        ].join("\n"),
      );
    });
}
