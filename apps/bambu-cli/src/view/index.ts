// `bambu view <model>`: the Review Page for one Model (docs/adr/0002). Loads
// the Model, runs the Printability Report checks on it as-is, packs a preview
// GLB, fills the viewer template, writes review.html beside the Model, and
// publishes it privately on wovn.

import { writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { EXIT_USAGE, fail, next, output } from "../cli.ts";
import type { Config } from "../config.ts";
import { readSource, type Source } from "../job.ts";
import { resolveMaterial, resolvePrinter } from "../analyze/index.ts";
import {
  analyze,
  bounds,
  decideUnits,
  load,
  printer as printerTable,
  scale,
} from "../mesh/index.ts";
import {
  ColorsLostError,
  loadColouredModel,
  ModelLoadError,
  nearestFilaments,
  NoColourError,
  paintModel,
} from "../paint/index.ts";
import { buildGlb, type PreviewMesh } from "./glb.ts";
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
          c.status === "pass"
            ? "ok"
            : c.status === "skipped"
              ? "skip"
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

// Model space is Z-up like the printer; the page expects the Model centred
// on the origin and resting on z = 0.
function centred(mesh: PreviewMesh): PreviewMesh {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, mesh.positions[i + k]!);
      max[k] = Math.max(max[k]!, mesh.positions[i + k]!);
    }
  const shift = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, min[2]!];
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) positions[i + k] = mesh.positions[i + k]! - shift[k]!;
  return { ...mesh, positions };
}

// A textured or vertex-coloured Model (GLB, glTF, OBJ) is previewed as it
// would print: each triangle in its Palette colour, with the Palette listed.
// Anything else, or a Model without colour, previews in the filament colour.
// `scale` maps the paint loader's millimetre coordinates onto the analysed mesh,
// which follows the unit decision rather than glTF's metre convention.
async function paintedPreview(
  file: string,
  scale: number,
): Promise<{ mesh: PreviewMesh; palette: NonNullable<Review["palette"]> } | undefined> {
  if (![".glb", ".gltf", ".obj"].includes(extname(file).toLowerCase())) return undefined;
  let coloured;
  try {
    coloured = await loadColouredModel(file);
  } catch (error) {
    if (error instanceof NoColourError || error instanceof ModelLoadError) return undefined;
    throw error;
  }
  let painted;
  try {
    painted = paintModel(coloured, { maxColors: 8 });
  } catch (error) {
    // A colour too fine for the mesh is left out of the preview, as of the print.
    if (!(error instanceof ColorsLostError)) throw error;
    painted = paintModel(coloured, { colors: error.kept });
  }
  const { vertices, faces, labels, palette, areaShare } = painted;
  const positions = new Float32Array(faces.length * 9),
    colors = new Float32Array(faces.length * 9);
  faces.forEach((face, f) => {
    const rgb = palette.rgb[labels[f]!]!;
    face.forEach((v, corner) => {
      positions.set(
        vertices[v]!.map((n) => n * scale),
        f * 9 + corner * 3,
      );
      colors.set(rgb, f * 9 + corner * 3);
    });
  });
  const filaments = nearestFilaments(palette.hex);
  return {
    mesh: { positions, colors },
    palette: palette.hex.map((hex, i) => ({
      hex,
      name: filaments[i] ? `${filaments[i].line} ${filaments[i].name}` : "",
      slot: "",
      areaPct: (areaShare[i] ?? 0) * 100,
    })),
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
      const page = resolve(options.output ?? resolve(dirname(file), "review.html"));
      if (page === file) fail("the page must not be the Model file", EXIT_USAGE);
      if (extname(page).toLowerCase() !== ".html")
        fail("the page must be an .html file", EXIT_USAGE);
      const notes: string[] = [];
      // The same unit decision analyze makes, so the report describes the
      // Model at its printed size; run analyze first to override it.
      const loaded = load(file);
      const units = decideUnits(Math.max(...bounds(loaded).extents), { declared: loaded.unit });
      if (units.doubtful)
        notes.push(units.note.replace("pass --unit", "run `bambu analyze --unit` first"));
      const mesh = Math.abs(units.scale - 1) > 1e-9 ? scale(loaded, units.scale) : loaded;
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
      const painted = await paintedPreview(file, units.scale / 1000);
      if (painted) review.palette = painted.palette;
      const glb = await buildGlb(
        centred(
          painted?.mesh ?? {
            positions: new Float32Array(mesh.positions),
            indices: new Uint32Array(mesh.indices),
          },
        ),
      );
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
