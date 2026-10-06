import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import {
  combineEstimates,
  EstimateError,
  parseGcodeHeader,
  parseResultJson,
  plateGcodes,
} from "./estimate.ts";
import { number, type Profile } from "./profiles.ts";
export const PLATES = {
  textured: { name: "Textured PEI Plate", tempKey: "textured_plate_temp_initial_layer" },
  cool: { name: "Cool Plate", tempKey: "cool_plate_temp_initial_layer" },
  engineering: { name: "Engineering Plate", tempKey: "eng_plate_temp_initial_layer" },
  "high-temp": { name: "High Temp Plate", tempKey: "hot_plate_temp_initial_layer" },
} as const;
export type Plate = keyof typeof PLATES;
export const MODEL_SUFFIXES = [".stl", ".3mf", ".obj", ".amf", ".ply", ".gltf", ".glb", ".fbx"];
export class SliceError extends Error {}
export interface SliceJob {
  model: string;
  output: string;
  machine: Profile;
  process: Profile;
  filament: Profile;
  plate?: Plate;
  timeout_s?: number;
}
export interface ProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logPath: string;
}
export interface ProcessResult {
  status: number | null;
  error?: Error;
  timedOut?: boolean;
}
// Redirect verbose Studio output to disk instead of buffering it in memory.
export function spawnSlicer(invocation: ProcessInvocation): ProcessResult {
  const log = openSync(invocation.logPath, "w");
  try {
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      timeout: invocation.timeoutMs,
      stdio: ["ignore", log, log],
    });
    return {
      status: result.status,
      error: result.error,
      timedOut: Boolean(
        result.error && "code" in result.error && result.error.code === "ETIMEDOUT",
      ),
    };
  } finally {
    closeSync(log);
  }
}
export const sliceFileSystem = {
  copyFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
};
export interface RunnerDependencies {
  spawn?: (invocation: ProcessInvocation) => ProcessResult;
  fs?: typeof sliceFileSystem;
}
export function buildCommand(cli: string[], work: string, model: string): string[] {
  return [
    ...cli,
    "--load-settings",
    `${join(work, "machine.json")};${join(work, "process.json")}`,
    "--load-filaments",
    join(work, "filament.json"),
    "--slice",
    "0",
    "--outputdir",
    work,
    "--export-3mf",
    "sliced.3mf",
    resolve(model),
  ];
}
export function checkModel(model: string, fs = sliceFileSystem): void {
  if (!fs.existsSync(model) || !fs.statSync(model).isFile())
    throw new ResolveModelError(`File not found: ${model}`, "not_found");
  const suffix = extname(model).toLowerCase();
  if ([".step", ".stp"].includes(suffix))
    throw new ResolveModelError(
      "Bambu Studio's command line can't read STEP files (the app can). Export an STL or 3MF from your CAD tool, or open the STEP and slice it in Bambu Studio.",
      "unsupported_format",
    );
  if (!MODEL_SUFFIXES.includes(suffix))
    throw new ResolveModelError(
      `Can't slice ${suffix || "files without an extension"}. Use one of: ${MODEL_SUFFIXES.join(", ")}`,
      "unsupported_format",
    );
}
export class ResolveModelError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}
export function checkOutput(model: string, output: string, fs = sliceFileSystem): void {
  const samePath = resolve(model) === resolve(output);
  const sameFile = fs.existsSync(output) && fs.realpathSync(model) === fs.realpathSync(output);
  const inputStat = fs.statSync(model);
  const outputStat = fs.existsSync(output) ? fs.statSync(output) : undefined;
  if (
    extname(output).toLowerCase() !== ".3mf" ||
    samePath ||
    sameFile ||
    (outputStat && inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino)
  )
    throw new ResolveModelError("-o must name a new .3mf file (not the input)", "bad_output");
}
const plateReport = z.object({
  id: z.number().int().positive(),
  filaments: z.array(z.object({ total_used_g: z.number() })),
  main_predication: z.number().optional(),
});
// Refuse any Plate whose flattened presets did not reach the generated G-code.
export function validatePlate(
  id: number,
  gcode: string,
  grams: number,
  filament: Profile,
  plate: Plate,
) {
  const selected = PLATES[plate];
  const expected = number(filament, selected.tempKey);
  if (!(grams > 0))
    throw new SliceError(`plate ${id} uses 0 g of filament: the filament profile did not load`);
  const loads = [...gcode.matchAll(/^M620\s+S(\d+)(?=\s|[A-Za-z]|$)/gm)];
  if (!loads.some((match) => Number(match[1]) !== 255))
    throw new SliceError(`plate ${id} never loads filament: the machine start gcode did not apply`);
  const bedTemp = Number(/^M190\s+S(\d+(?:\.\d+)?)(?=\s|$)/m.exec(gcode)?.[1]);
  if (bedTemp !== expected)
    throw new SliceError(
      `plate ${id} heats the bed to ${bedTemp}C, but the filament wants ${expected}C on the ${selected.name}`,
    );
  return { id, filament_g: grams, bed_temp_c: bedTemp, preview: `Metadata/plate_${id}.png` };
}
// Keep scratch logs on failure; only a validated sliced 3MF reaches the requested output.
export function runSlice(
  cli: string[],
  job: SliceJob,
  { spawn = spawnSlicer, fs = sliceFileSystem }: RunnerDependencies = {},
) {
  checkModel(job.model, fs);
  checkOutput(job.model, job.output, fs);
  const timeout = job.timeout_s ?? 300;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new ResolveModelError("timeout must be greater than 0", "bad_arguments");
  fs.mkdirSync(dirname(resolve(job.output)), { recursive: true });
  const work = fs.mkdtempSync(join(dirname(resolve(job.output)), ".bambu-slice-"));
  const logPath = join(work, "slice.log");
  const plate = job.plate ?? "textured";
  const started = performance.now();
  let succeeded = false;
  try {
    for (const [stem, profile] of Object.entries({
      machine: job.machine,
      process: { ...job.process, curr_bed_type: PLATES[plate].name },
      filament: job.filament,
    }))
      fs.writeFileSync(join(work, `${stem}.json`), JSON.stringify(profile, null, 2));
    const command = buildCommand(cli, work, job.model);
    const executable = command[0];
    if (!executable) throw new SliceError("could not run an empty slicer command");
    const completed = spawn({
      command: executable,
      args: command.slice(1),
      cwd: work,
      timeoutMs: timeout * 1000,
      logPath,
    });
    let document: Record<string, unknown> | undefined;
    try {
      document = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(fs.readFileSync(join(work, "result.json"), "utf8")));
    } catch {
      /* The G-code headers carry fallback estimates. */
    }
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const errors = log
      .split("\n")
      .filter((line) => line.includes("[error]"))
      .slice(-5)
      .join("\n");
    if (completed.timedOut)
      throw new SliceError(
        `Bambu Studio did not finish within ${timeout} s. Simplify the Model or allow more time.`,
      );
    if (completed.error)
      throw new SliceError(`could not run ${executable}: ${completed.error.message}`);
    if (
      completed.status !== 0 ||
      (typeof document?.return_code === "number" && document.return_code !== 0)
    ) {
      const reason =
        typeof document?.error_string === "string"
          ? `Bambu Studio: ${document.error_string} (code ${document.return_code})`
          : `Bambu Studio exited with code ${completed.status} and no result.json. Versions 02.05.00-02.05.01 crash in command-line mode; update if yours is one.`;
      throw new SliceError(`${reason}\n${errors || log.trim().split("\n").slice(-8).join("\n")}`);
    }
    const sliced = join(work, "sliced.3mf");
    let gcodes: Map<number, string>;
    try {
      gcodes = plateGcodes(fs.readFileSync(sliced));
    } catch {
      throw new SliceError("Bambu Studio exited without writing a sliced 3MF.");
    }
    const reports =
      document && Array.isArray(document.sliced_plates)
        ? z.array(plateReport).safeParse(document.sliced_plates)
        : undefined;
    if (reports && (!reports.success || !reports.data.length))
      throw new SliceError("Bambu Studio reported no readable sliced plates");
    if (
      reports?.success &&
      (reports.data.length !== gcodes.size ||
        new Set(reports.data.map((p) => p.id)).size !== gcodes.size ||
        reports.data.some((p) => !gcodes.has(p.id)))
    )
      throw new SliceError("result.json and sliced 3MF disagree on sliced plates");
    const summaries = [...gcodes].map(([id, archived]) => {
      const path = join(work, `plate_${id}.gcode`);
      const gcode = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : archived;
      const report = reports?.success ? reports.data.find((p) => p.id === id) : undefined;
      const grams = report
        ? report.filaments.reduce((sum, f) => sum + f.total_used_g, 0)
        : parseGcodeHeader(archived.split("\n")).filament_g;
      const summary = validatePlate(id, gcode, grams, job.filament, plate);
      // The archived G-code is what will be printed, so validate it as well.
      validatePlate(id, archived, grams, job.filament, plate);
      return summary;
    });
    let estimate;
    try {
      estimate = parseResultJson(document);
    } catch (error) {
      if (!(error instanceof EstimateError)) throw error;
      estimate = combineEstimates([...gcodes.values()].map((g) => parseGcodeHeader(g.split("\n"))));
    }
    const version =
      /^; BambuStudio (\S+)/m.exec([...gcodes.values()][0]?.slice(0, 512) ?? "")?.[1] ?? "";
    checkOutput(job.model, job.output, fs);
    // Copied beside the destination, then renamed, so a failed copy never
    // damages a previous slice at the same path.
    const staged = `${resolve(job.output)}.tmp`;
    try {
      fs.copyFileSync(sliced, staged);
      fs.renameSync(staged, resolve(job.output));
    } finally {
      fs.rmSync(staged, { force: true });
    }
    succeeded = true;
    return {
      output_file: resolve(job.output),
      estimate,
      bambu_studio_version: version,
      seconds: (performance.now() - started) / 1000,
      plate_summaries: summaries,
    };
  } catch (error) {
    throw new SliceError(
      `${error instanceof Error ? error.message : String(error)}\nlog ${logPath}`,
    );
  } finally {
    if (succeeded) fs.rmSync(work, { recursive: true, force: true });
  }
}
export type SliceResult = ReturnType<typeof runSlice>;
