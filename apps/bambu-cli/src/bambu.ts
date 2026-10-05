// bambu - tooling for a Bambu Lab printer: status, camera, SD card, headless
// slicing, and setup. The agent-facing guide is skills/bambu-print/SKILL.md.
//
// Firmware 01.08+ rejects unsigned LAN control commands (HMS
// 0500-0500-0001-0007) unless Developer Mode is on, so this CLI only reads
// state and moves files. Starting a print goes through Bambu Connect in the
// agent VM (docs/adr/0003). Settings and secrets: see config.ts.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Client as FtpClient } from "basic-ftp";
import { Argument, Command, CommanderError } from "commander";
import { EXIT_USAGE, fail } from "./cli.ts";
import { Config, mask, type Printer, SECRET_KEYS, type SecretKey, SETTING_KEYS } from "./config.ts";
import { diagnose, report } from "./doctor.ts";
import { register as registerAnalyze } from "./analyze/index.ts";
import { register as registerGenerate } from "./generate/index.ts";
import { register as registerMake } from "./make/index.ts";
import { register as registerPaint } from "./paint/index.ts";
import { register as registerPrinter } from "./printer/index.ts";
import { register as registerSearch } from "./search/index.ts";
import { register as registerSlice } from "./slice/index.ts";
import { register as registerView } from "./view/index.ts";

const USER = "bblp";

// mqtt still calls url.parse, which Node 24 reports as deprecated on every
// printer command; the note is noise for the agent reading stderr.
process.noDeprecation = true;

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
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
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
      // A camera frame is a JPEG of a few hundred KB; anything past this is not one.
      if (size > MAX_FRAME_BYTES)
        return socket.destroy(new Error(`camera announced a ${size} byte frame`));
      if (buffer.length >= 16 + size) done(buffer.subarray(16, 16 + size));
    });
    socket.on("error", reject);
    socket.on("end", () => reject(new Error("camera closed the connection (wrong access code?)")));
  });
  socket.destroy();
  writeFileSync(out, jpeg);
  console.log(out);
}

const program = new Command("bambu")
  .description("a Bambu Lab printer: find, generate, make, check, review, slice, and watch Models")
  // Set before the subcommands are created, which copy it.
  .exitOverride();

// Commands in workflow order (skills/bambu-print/SKILL.md), then the printer.
registerSearch(program, config);
registerGenerate(program, config);
registerMake(program, config);
registerAnalyze(program, config);
registerPaint(program, config);
registerView(program, config);
registerSlice(program, config);
registerPrinter(program, config);

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

// Secrets arrive on stdin unless --value is given, so they stay out of shell
// history and process listings: one unechoed line at a terminal, or the whole
// of a pipe.
async function readSecretValue(value?: string): Promise<string> {
  const secret = (
    value ?? (process.stdin.isTTY ? await promptHidden() : readFileSync(0, "utf8"))
  ).trim();
  if (!secret) fail("empty secret");
  return secret;
}
function promptHidden(): Promise<string> {
  // The line editor echoes into a muted stream, so nothing typed is shown.
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write("Secret: ");
  return rl.question("").finally(() => {
    rl.close();
    process.stderr.write("\n");
  });
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
    if (pairs.length % 2) fail("expected key value pairs", EXIT_USAGE);
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
  .action(async (name: SecretKey, options: { value?: string; unset?: boolean }) => {
    if (options.unset) {
      config.unsetSecret(name);
      console.log(`removed ${name}`);
      return;
    }
    config.setSecret(name, await readSecretValue(options.value));
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
        : `no access code found to copy; kept ${config.legacyFile}. Set it with \`bambu config secret access_code\`, then delete that file`,
    );
  });

program
  .command("doctor")
  .description("check Bambu Studio, the VM tooling, settings, and secrets")
  .action(() => {
    const { text, ok } = report(diagnose(config));
    console.log(text);
    if (!ok) process.exit(1);
  });

// Commander's own parse errors (unknown option, missing argument) exit 2 like
// every other usage error, with the error document when --json was asked for;
// help and version keep exit 0.
await program.parseAsync().catch((error: Error) => {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) process.exit(0);
    if (process.argv.includes("--json"))
      console.log(
        JSON.stringify(
          { error: { type: "usage", message: error.message.replace(/^error: /, "") } },
          null,
          2,
        ),
      );
    process.exit(EXIT_USAGE);
  }
  fail(error.message);
});
