// bambu - tooling for a Bambu Lab printer: status, camera, SD card, headless
// slicing, and setup. The agent-facing guide is skills/bambu-print/SKILL.md.
//
// Firmware 01.08+ rejects unsigned LAN control commands (HMS
// 0500-0500-0001-0007) unless Developer Mode is on, so this CLI only reads
// state and moves files. Starting a print goes through Bambu Connect in the
// agent VM (docs/adr/0003). Settings and secrets: see config.ts.

import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Client as FtpClient } from "basic-ftp";
import { Argument, Command, Option } from "commander";
import { fail } from "./cli.ts";
import { Config, mask, type Printer, SECRET_KEYS, type SecretKey, SETTING_KEYS } from "./config.ts";
import { diagnose, report } from "./doctor.ts";
import { register as registerMake } from "./make/index.ts";
import { register as registerPrinter } from "./printer/index.ts";
import { register as registerSearch } from "./search/index.ts";
import { PROFILES, STUDIO_CLI } from "./studio.ts";

const USER = "bblp";

const config = new Config();

// The printer serves a self-signed cert from Bambu's own CA.
const insecureTls = { rejectUnauthorized: false } as const;

// Implicit FTPS on 990. The printer never sends a TLS close_notify after a
// transfer, which is fine for basic-ftp but hangs clients that wait for it.
async function withFtp<T>(printer: Printer, run: (ftp: FtpClient) => Promise<T>) {
  const ftp = new FtpClient(15_000);
  try {
    await ftp.access({
      host: printer.host,
      port: 990,
      user: USER,
      password: printer.accessCode,
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
async function snapshot(printer: Printer, out: string) {
  const auth = Buffer.alloc(80);
  auth.writeUInt32LE(0x40, 0);
  auth.writeUInt32LE(0x3000, 4);
  auth.write(USER, 16, "ascii");
  auth.write(printer.accessCode, 48, "ascii");
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

// Studio's CLI does not resolve `inherits` or `include` for system profiles, so
// a profile loaded as-is silently falls back to defaults (wrong bed temps, 0 g
// weight, a generic start gcode that never loads AMS filament). Merge into one
// self-contained profile: parent chain, then included templates, then own keys.
function flatten(category: string, name: string): Profile {
  const own = JSON.parse(readFileSync(`${PROFILES}/${category}/${name}.json`, "utf8")) as Profile;
  const { inherits, include, ...rest } = own;
  const parent = typeof inherits === "string" ? flatten(category, inherits) : {};
  const included = Array.isArray(include) ? include.map((n: string) => flatten(category, n)) : [];
  return Object.assign(parent, ...included, rest);
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
    STUDIO_CLI,
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
    // The P1S start gcode loads the first filament with `M620 S<slot>`; without
    // it the printer runs the whole job with an empty nozzle.
    if (!/^M620 S(?!255)\d+/m.test(gcode))
      refuse(`plate ${sliced.id} never loads filament: the machine start gcode did not apply`);
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
  .command("snapshot")
  .description("save one camera frame")
  .argument("[out]", "output JPEG", join(tmpdir(), "bambu-snapshot.jpg"))
  .action((out: string) => snapshot(config.printer(), resolve(out)));

program
  .command("files")
  .description("list the SD card root")
  .action(() =>
    withFtp(config.printer(), async (ftp) => {
      for (const f of await ftp.list()) console.log(f.name);
    }),
  );

program
  .command("upload")
  .description("copy a file to the SD card root")
  .argument("<file>")
  .action((file: string) =>
    withFtp(config.printer(), async (ftp) => {
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

// Secrets arrive on stdin unless --value is given, so they stay out of shell
// history and process listings.
function readSecretValue(value?: string): string {
  const secret = (value ?? readFileSync(0, "utf8")).trim();
  if (!secret) fail("empty secret");
  return secret;
}

const configCommand = program
  .command("config")
  .description("settings in config.json and secrets in the Keychain");
configCommand
  .command("show")
  .description("current settings, secrets masked")
  .action(() => {
    const settings = config.settings();
    for (const key of SETTING_KEYS) console.log(`${key}: ${settings[key] ?? "(not set)"}`);
    for (const key of SECRET_KEYS) console.log(`${key}: ${mask(config.secret(key))}`);
  });
configCommand
  .command("set")
  .description("set settings, e.g. set printer_ip 10.0.0.5 serial 01P00A")
  .argument("<pairs...>", `key value pairs; keys: ${SETTING_KEYS.join(", ")}`)
  .action((pairs: string[]) => {
    if (pairs.length % 2) fail("expected key value pairs");
    const updates: Record<string, string> = {};
    for (let i = 0; i < pairs.length; i += 2) updates[pairs[i]!] = pairs[i + 1]!;
    config.set(updates);
    console.log(`saved ${config.file}`);
  });
configCommand
  .command("unset")
  .argument("<keys...>")
  .description("remove settings")
  .action((keys: string[]) => {
    config.unset(keys);
    console.log(`saved ${config.file}`);
  });
configCommand
  .command("secret")
  .description("store a secret in the Keychain, read from stdin unless --value is given")
  .addArgument(new Argument("<name>").choices(SECRET_KEYS))
  .option("--value <secret>", "the secret itself")
  .option("--unset", "remove it instead")
  .action((name: SecretKey, options: { value?: string; unset?: boolean }) => {
    if (options.unset) {
      config.unsetSecret(name);
      console.log(`removed ${name}`);
      return;
    }
    config.setSecret(name, readSecretValue(options.value));
    console.log(`stored ${name} in the Keychain`);
  });
configCommand
  .command("path")
  .description("print the settings file path")
  .action(() => console.log(config.file));
configCommand
  .command("migrate")
  .description("move a pre-port printer.json and its Keychain entry to the current layout")
  .action(() => {
    const result = config.migrate();
    if (!result) {
      console.log(`nothing to migrate: no ${config.legacyFile}`);
      return;
    }
    console.log(`saved ${config.file}`);
    console.log(
      result.accessCode
        ? "copied the access code into the Keychain"
        : "no access code found to copy",
    );
  });

registerMake(program, config);
registerPrinter(program, config);
registerSearch(program, config);

program
  .command("doctor")
  .description("check Bambu Studio, the VM tooling, settings, and secrets")
  .action(() => {
    const { text, ok } = report(diagnose(config));
    console.log(text);
    if (!ok) process.exit(1);
  });

await program.parseAsync().catch((error: Error) => fail(error.message));
