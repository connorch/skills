// bambu - LAN tooling for a Bambu Lab printer: status, camera, SD card, and
// headless slicing. The agent-facing guide is skills/bambu-print/SKILL.md.
//
// Firmware 01.08+ rejects unsigned LAN control commands (HMS
// 0500-0500-0001-0007) unless Developer Mode is on, so this CLI only reads
// state and moves files. Starting a print goes through Bambu Studio.
//
// The printer is configured in ~/.config/bambu/printer.json:
//   { "host": "10.128.1.128", "serial": "01P00C...", "keychainService": "openclaw-bambu-p1s" }
// and its LAN access code lives in the macOS Keychain under that service,
// account "bblp".

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Client as FtpClient } from "basic-ftp";
import { Command, Option } from "commander";
import mqtt from "mqtt";

const USER = "bblp";
const CONFIG_FILE = join(homedir(), ".config", "bambu", "printer.json");
const STUDIO = "/Applications/BambuStudio.app";
const PROFILES = `${STUDIO}/Contents/Resources/profiles/BBL`;

interface PrinterConfig {
  host: string;
  serial: string;
  keychainService: string;
}

// The subset of the printer's `print` report this CLI reads.
interface PrinterStatus {
  gcode_state?: string;
  subtask_name?: string;
  mc_percent?: number;
  mc_remaining_time?: number;
  layer_num?: number;
  total_layer_num?: number;
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  wifi_signal?: string;
  print_error?: number;
  hms?: unknown[];
  lights_report?: { node: string; mode: string }[];
  ams?: {
    ams?: {
      id: string;
      humidity_raw?: string;
      tray?: { id: string; tray_type?: string; tray_color?: string }[];
    }[];
  };
}

function fail(message: string): never {
  console.error(`bambu: ${message}`);
  process.exit(1);
}

function config(): PrinterConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PrinterConfig;
  } catch {
    fail(`no printer config at ${CONFIG_FILE}`);
  }
}

function accessCode(printer: PrinterConfig): string {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", USER, "-s", printer.keychainService, "-w"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    fail(`no access code in the Keychain (service ${printer.keychainService}, account ${USER})`);
  }
}

// The printer serves a self-signed cert from Bambu's own CA.
const insecureTls = { rejectUnauthorized: false } as const;

async function fetchStatus(printer: PrinterConfig): Promise<PrinterStatus> {
  const client = await mqtt.connectAsync(`mqtts://${printer.host}:8883`, {
    username: USER,
    password: accessCode(printer),
    ...insecureTls,
    connectTimeout: 10_000,
    reconnectPeriod: 0,
  });
  try {
    const report = new Promise<PrinterStatus>((done) => {
      client.on("message", (_topic, payload) => {
        const doc = JSON.parse(payload.toString()) as { print?: PrinterStatus };
        // The printer also pushes partial deltas; wait for the full pushall
        // reply, which is the one carrying temperatures and AMS state.
        const p = doc.print;
        if (p?.gcode_state && p.nozzle_temper !== undefined && p.ams) done(p);
      });
    });
    await client.subscribeAsync(`device/${printer.serial}/report`);
    await client.publishAsync(
      `device/${printer.serial}/request`,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for a status report")), 15_000);
    });
    // Clear the losing timer, or it holds the process open for the full 15s.
    return await Promise.race([report, timeout]).finally(() => clearTimeout(timer));
  } finally {
    await client.endAsync(true);
  }
}

function summarize(s: PrinterStatus): string {
  const lines = [`State: ${s.gcode_state}`];
  if (["RUNNING", "PAUSE", "PREPARE"].includes(s.gcode_state ?? "")) {
    const mins = s.mc_remaining_time ?? 0;
    lines.push(
      `Job: ${s.subtask_name} - ${s.mc_percent}%, layer ${s.layer_num}/${s.total_layer_num}, ` +
        `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m left`,
    );
  }
  const temp = (n?: number) => (n ?? 0).toFixed(0);
  lines.push(
    `Nozzle ${temp(s.nozzle_temper)}/${temp(s.nozzle_target_temper)}C, ` +
      `bed ${temp(s.bed_temper)}/${temp(s.bed_target_temper)}C`,
  );
  const light = s.lights_report?.find((l) => l.node === "chamber_light")?.mode ?? "?";
  lines.push(`Light: ${light}, wifi ${s.wifi_signal}`);
  for (const unit of s.ams?.ams ?? []) {
    const trays = (unit.tray ?? []).map(
      (t) =>
        `A${Number(unit.id) * 4 + Number(t.id) + 1}:${t.tray_type || "empty"}#${(t.tray_color ?? "").slice(0, 6)}`,
    );
    lines.push(`AMS ${unit.id} (${unit.humidity_raw ?? "?"}% RH): ${trays.join("  ")}`);
  }
  if (s.print_error) lines.push(`Print error: ${s.print_error}`);
  if (s.hms?.length) lines.push(`HMS alerts: ${JSON.stringify(s.hms)}`);
  return lines.join("\n");
}

// Implicit FTPS on 990. The printer never sends a TLS close_notify after a
// transfer, which is fine for basic-ftp but hangs clients that wait for it.
async function withFtp<T>(printer: PrinterConfig, run: (ftp: FtpClient) => Promise<T>) {
  const ftp = new FtpClient(15_000);
  try {
    await ftp.access({
      host: printer.host,
      port: 990,
      user: USER,
      password: accessCode(printer),
      secure: "implicit",
      secureOptions: insecureTls,
    });
    return await run(ftp);
  } finally {
    ftp.close();
  }
}

// One JPEG from the camera stream on 6000: an 80-byte auth packet, then a
// 16-byte frame header whose first 4 bytes are the JPEG size.
async function snapshot(printer: PrinterConfig, out: string) {
  const auth = Buffer.alloc(80);
  auth.writeUInt32LE(0x40, 0);
  auth.writeUInt32LE(0x3000, 4);
  auth.write(USER, 16, "ascii");
  auth.write(accessCode(printer), 48, "ascii");
  const socket: TLSSocket = tlsConnect({ host: printer.host, port: 6000, ...insecureTls });
  socket.setTimeout(10_000, () => socket.destroy(new Error("camera timed out")));
  const jpeg = await new Promise<Buffer>((done, reject) => {
    let buffer = Buffer.alloc(0);
    socket.once("secureConnect", () => socket.write(auth));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 16) return;
      const size = buffer.readUInt32LE(0);
      if (buffer.length >= 16 + size) done(buffer.subarray(16, 16 + size));
    });
    socket.on("error", reject);
    socket.on("end", () => reject(new Error("camera closed the connection (wrong access code?)")));
  });
  socket.destroy();
  writeFileSync(out, jpeg);
  console.log(out);
}

// Bed type name Studio expects, and the filament setting holding its
// first-layer bed temperature.
const PLATES = {
  textured: { name: "Textured PEI Plate", tempKey: "textured_plate_temp_initial_layer" },
  cool: { name: "Cool Plate", tempKey: "cool_plate_temp_initial_layer" },
  engineering: { name: "Engineering Plate", tempKey: "eng_plate_temp_initial_layer" },
  "high-temp": { name: "High Temp Plate", tempKey: "hot_plate_temp_initial_layer" },
} as const;
type Plate = keyof typeof PLATES;

type Profile = Record<string, unknown>;

// Studio's CLI does not resolve `inherits` for system profiles, so a profile
// loaded as-is silently falls back to defaults (wrong bed temps, 0 g weight).
// Merge the chain parent-first into one self-contained profile.
function flatten(category: string, name: string): Profile {
  const own = JSON.parse(readFileSync(`${PROFILES}/${category}/${name}.json`, "utf8")) as Profile;
  const { inherits, ...rest } = own;
  return typeof inherits === "string" ? { ...flatten(category, inherits), ...rest } : rest;
}

// Headless slice with Bambu Studio's bundled system profiles. Studio runs in a
// private temp directory (it needs absolute paths and an existing output
// directory), and only a validated 3mf is copied to `--out`.
function slice(
  model: string,
  o: { out: string; machine: string; process: string; filament: string; plate: Plate },
) {
  const outDir = resolve(o.out);
  const outFile = `${basename(model).replace(/\.[^.]+$/, "")}.3mf`;
  const outPath = join(outDir, outFile);
  // Compare real paths: this sees through symlinks and, on macOS, case
  // differences on case-insensitive volumes.
  if (existsSync(outPath) && realpathSync.native(outPath) === realpathSync.native(model))
    fail(`output would overwrite ${model}; pass a different --out`);
  const plate = PLATES[o.plate];
  const filament = flatten("filament", o.filament);
  const work = mkdtempSync(join(tmpdir(), "bambu-slice-"));
  const write = (category: string, profile: Profile) => {
    const path = join(work, `${category}.json`);
    writeFileSync(path, JSON.stringify(profile));
    return path;
  };
  const machinePath = write("machine", flatten("machine", o.machine));
  const processPath = write("process", {
    ...flatten("process", o.process),
    curr_bed_type: plate.name,
  });
  const filamentPath = write("filament", filament);
  const logPath = join(work, "slice.log");
  const log = openSync(logPath, "w");
  const result = spawnSync(
    `${STUDIO}/Contents/MacOS/BambuStudio`,
    [
      "--orient",
      "0",
      "--arrange",
      "1",
      "--load-settings",
      `${machinePath};${processPath}`,
      "--load-filaments",
      filamentPath,
      "--slice",
      "0",
      "--outputdir",
      work,
      "--export-3mf",
      outFile,
      resolve(model),
    ],
    // Studio logs verbosely; write to a file instead of spawnSync's 1 MiB buffer.
    { stdio: ["ignore", log, log] },
  );
  closeSync(log);
  if (result.error) fail(`could not run Bambu Studio: ${result.error.message}`);
  if (result.status !== 0) {
    const errors = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.includes("[error]"));
    fail(`slicing failed (exit ${result.status}), log ${logPath}:\n${errors.slice(-5).join("\n")}`);
  }

  // Refuse output that shows the profiles did not apply, on any plate: no
  // filament weight, or a first-layer bed temperature other than the
  // filament's for this plate type. A refused 3mf never reaches `--out`.
  const refuse = (message: string): never => {
    rmSync(work, { recursive: true, force: true });
    fail(message);
  };
  const report = JSON.parse(readFileSync(join(work, "result.json"), "utf8")) as {
    sliced_plates: {
      id: number;
      main_predication: number;
      filaments: { total_used_g: number }[];
    }[];
  };
  if (!report.sliced_plates.length) refuse("Bambu Studio reported no sliced plates");
  const expected = Number((filament[plate.tempKey] as string[] | undefined)?.[0]);
  const summaries = report.sliced_plates.map((sliced) => {
    const grams = sliced.filaments.reduce((sum, f) => sum + f.total_used_g, 0);
    const gcode = readFileSync(join(work, `plate_${sliced.id}.gcode`), "utf8");
    const bedTemp = Number(/^M190 S(\d+)/m.exec(gcode)?.[1]);
    if (!(grams > 0))
      refuse(`plate ${sliced.id} uses 0 g of filament: the filament profile did not load`);
    if (bedTemp !== expected)
      refuse(
        `plate ${sliced.id} heats the bed to ${bedTemp}C, but ${o.filament} wants ${expected}C on the ${plate.name}`,
      );
    const minutes = Math.round(sliced.main_predication / 60);
    return `plate ${sliced.id}: ~${minutes} min, ${grams.toFixed(1)} g, ${plate.name} at ${bedTemp}C (preview Metadata/plate_${sliced.id}.png)`;
  });

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(work, outFile), outPath);
  rmSync(work, { recursive: true, force: true });
  console.log(outPath);
  for (const line of summaries) console.log(line);
}

const program = new Command("bambu").description("LAN tooling for a Bambu Lab printer");

program
  .command("status")
  .description("print state, temperatures, AMS trays, alerts")
  .option("--json", "raw status report")
  .action(async (o: { json?: boolean }) => {
    const s = await fetchStatus(config());
    console.log(o.json ? JSON.stringify(s, null, 2) : summarize(s));
  });

program
  .command("snapshot")
  .description("save one camera frame")
  .argument("[out]", "output JPEG", join(tmpdir(), "bambu-snapshot.jpg"))
  .action((out: string) => snapshot(config(), resolve(out)));

program
  .command("files")
  .description("list the SD card root")
  .action(() =>
    withFtp(config(), async (ftp) => {
      for (const f of await ftp.list()) console.log(f.name);
    }),
  );

program
  .command("upload")
  .description("copy a file to the SD card root")
  .argument("<file>")
  .action((file: string) =>
    withFtp(config(), async (ftp) => {
      await ftp.uploadFrom(createReadStream(file), basename(file));
      console.log(`uploaded ${basename(file)}`);
    }),
  );

program
  .command("slice")
  .description("slice a model into a printable 3mf with Bambu Studio")
  .argument("<model>", "STL, STEP, or 3MF")
  .option("--out <dir>", "output directory", ".")
  .option("--machine <profile>", "machine profile", "Bambu Lab P1S 0.4 nozzle")
  .option("--process <profile>", "process profile", "0.20mm Standard @BBL X1C")
  .option("--filament <profile>", "filament profile", "Bambu PLA Basic @BBL P1S 0.4 nozzle")
  .addOption(
    new Option("--plate <type>", "build plate").choices(Object.keys(PLATES)).default("textured"),
  )
  .action(slice);

await program.parseAsync().catch((error: Error) => fail(error.message));
