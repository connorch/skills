// mac-vm - start and stop an on-demand macOS VM (Tart) so an agent can use GUI
// apps while the host Mac is locked. The agent-facing guide is
// skills/mac-vm/SKILL.md.
//
// The VM is off by default: `up` boots it headless, `down` shuts it off. Run
// commands and copy files with `tart exec` (the Cirrus images ship its guest
// agent). The guest's screen and input go through Tart's VNC server
// (`shot`, `click`, `type`, `key`), so no agent runs inside the guest. SSH is
// only used for `--forward`, which reverse-tunnels host loopback ports into
// the guest so apps there can reach host-only services.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command, Option } from "commander";
import { charKeysym, KEYSYMS, needsShift, Rfb } from "./rfb.ts";

const STATE_DIR = join(homedir(), ".local", "state", "mac-vm");
// Every guest built by `init` from the Cirrus images logs in as this user.
const GUEST_USER = "admin";
const KEY = join(homedir(), ".ssh", "mac-vm_ed25519");
const BOOT_TIMEOUT_S = 240;
const SSH_OPTS = [
  "-i",
  KEY,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
];

// Throws rather than exiting, so `up` can roll back a VM it started; the
// entry point prints the message and exits 1.
function fail(message: string): never {
  throw new Error(message);
}

// Time-boxed so a wedged guest agent cannot outlast the callers' own deadlines.
function tart(args: string[], timeoutMs = 30_000) {
  return spawnSync("tart", args, { encoding: "utf8", timeout: timeoutMs });
}

// The local VM's entry in `tart list`, if it exists.
function findVm(vm: string) {
  const list = tart(["list", "--format", "json"]);
  if (list.status !== 0) fail(`tart list failed: ${list.stderr.trim()}`);
  const vms = JSON.parse(list.stdout) as { Name: string; Source: string; Running: boolean }[];
  return vms.find((v) => v.Source === "local" && v.Name === vm);
}

function isRunning(vm: string): boolean {
  const found = findVm(vm);
  if (!found) fail(`no VM named ${vm} (see \`tart list\`, or run \`mac-vm init\`)`);
  return found.Running;
}

// The reverse tunnels into the guest at `address`, read from the process list.
// Each tunnel's ssh command line already names its port and the VM's address,
// so there is no state file to drift out of sync with reality.
function tunnels(address: string): { pid: number; port: number }[] {
  const ps = spawnSync("ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8" });
  const target = new RegExp(
    `^\\s*(\\d+) ssh .*-R (\\d+):127\\.0\\.0\\.1:\\2 ${GUEST_USER}@${address.replaceAll(".", "\\.")}$`,
  );
  return ps.stdout.split("\n").flatMap((line) => {
    const m = target.exec(line);
    return m ? [{ pid: Number(m[1]), port: Number(m[2]) }] : [];
  });
}

// Poll `probe` about once a second until it passes (true) or `seconds` of wall
// time run out (false). A slow probe eats into the deadline instead of adding to it.
async function waitFor(seconds: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await sleep(1000);
  }
  return false;
}

function ip(vm: string): string {
  const result = tart(["ip", vm, "--wait", String(BOOT_TIMEOUT_S)], (BOOT_TIMEOUT_S + 10) * 1000);
  if (result.status !== 0) fail(`no IP for ${vm}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// Boot the VM if needed and run `work` against it. If this call started the VM
// and anything fails (including the boot itself), shut it back down: an
// always-unlocked VM must never be left running by a failed command.
async function withVm<T>(vm: string, work: (started: boolean) => Promise<T>): Promise<T> {
  const started = !isRunning(vm);
  try {
    await boot(vm, started);
    return await work(started);
  } catch (error) {
    if (started) await down(vm, 60);
    throw error;
  }
}

// Tart prints the VNC address, password included, into the log; a fresh log
// per boot keeps only the live one, readable by this user alone.
function logFile(vm: string) {
  return join(STATE_DIR, `${vm}.log`);
}
async function boot(vm: string, start: boolean) {
  if (start) {
    mkdirSync(STATE_DIR, { recursive: true });
    const log = openSync(logFile(vm), "w", 0o600);
    spawn("tart", ["run", "--no-graphics", "--vnc-experimental", vm], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  }
  // The guest agent can answer before auto-login finishes; wait for a console user.
  const loggedIn = () =>
    tart(["exec", vm, "sh", "-c", '[ "$(stat -f %Su /dev/console)" != root ]']).status === 0;
  if (!(await waitFor(BOOT_TIMEOUT_S, loggedIn)))
    fail(`timed out after ${BOOT_TIMEOUT_S}s waiting for the guest desktop login`);
}

function up(vm: string, forwards: number[]) {
  return withVm(vm, () => forward(vm, forwards));
}

async function forward(vm: string, forwards: number[]) {
  const address = ip(vm);
  for (const port of forwards) {
    if (tunnels(address).some((t) => t.port === port)) continue;
    const ssh = spawn(
      "ssh",
      [
        ...SSH_OPTS,
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ConnectTimeout=10",
        "-R",
        `${port}:127.0.0.1:${port}`,
        `${GUEST_USER}@${address}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    ssh.unref();
    // Ready once the port answers inside the guest, not just once ssh is running.
    const ready = await waitFor(20, () => {
      if (!tunnels(address).some((t) => t.pid === ssh.pid))
        fail(`reverse tunnel for port ${port} exited (was \`mac-vm init\` run?)`);
      return tart(["exec", vm, "nc", "-z", "127.0.0.1", String(port)]).status === 0;
    });
    if (!ready) {
      ssh.kill();
      fail(`reverse tunnel for port ${port} never became reachable in the guest`);
    }
  }
  console.log(
    `${vm} up at ${address}${forwards.length ? `, forwarding ${forwards.join(", ")}` : ""}`,
  );
}

// Shut down from inside the guest so it flushes its disk: `tart stop` alone
// can force the VM off and lose recent writes. Falls back to `tart stop` if
// the guest agent is unreachable or the shutdown hangs.
async function down(vm: string, timeout: number) {
  if (isRunning(vm)) {
    const address = tart(["ip", vm]).stdout.trim();
    for (const t of address ? tunnels(address) : []) {
      try {
        process.kill(t.pid);
      } catch (error) {
        // Already gone between listing and killing: that is closed.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // Bounded: a wedged guest agent must not block the `tart stop` fallback.
    tart(["exec", vm, "sudo", "-n", "shutdown", "-h", "now"], 15_000);
    await waitFor(timeout, () => !isRunning(vm));
    if (isRunning(vm)) {
      const result = tart(["stop", vm, "--timeout", "5"]);
      if (result.status !== 0) fail(`tart stop failed: ${result.stderr.trim()}`);
    }
  }
  console.log(`${vm} down`);
}

function status(vm: string, json: boolean) {
  const running = isRunning(vm);
  const address = running ? tart(["ip", vm]).stdout.trim() || null : null;
  const report = {
    vm,
    running,
    ip: address,
    guestAgent: running && tart(["exec", vm, "true"]).status === 0,
    vnc: running ? (vncUrl(vm)?.port ?? null) : null,
    tunnels: address ? tunnels(address) : [],
  };
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(`${vm}: ${running ? `running at ${report.ip ?? "?"}` : "stopped"}`);
  if (running) console.log(`guest agent: ${report.guestAgent ? "ready" : "not ready"}`);
  if (running)
    console.log(
      `vnc: ${report.vnc ? `port ${report.vnc}` : "not available (booted outside mac-vm?)"}`,
    );
  for (const t of report.tunnels) console.log(`tunnel ${t.port}: up`);
}

// The VNC address of the running VM, from the boot log.
function vncUrl(vm: string): URL | undefined {
  try {
    const match = readFileSync(logFile(vm), "utf8")
      .match(/vnc:\/\/[^\s]+/g)
      ?.at(-1);
    return match ? new URL(match) : undefined;
  } catch {
    return undefined;
  }
}

// Open the screen of a running VM for one command, and close it after.
async function withScreen<T>(vm: string, work: (screen: Rfb) => Promise<T>): Promise<T> {
  if (!isRunning(vm)) fail(`${vm} is not running; run \`mac-vm up\` first`);
  const url = vncUrl(vm);
  if (!url)
    fail(
      `${vm} has no VNC address; it was booted outside mac-vm, so run \`mac-vm down\` then \`mac-vm up\``,
    );
  const screen = await Rfb.open(url);
  try {
    return await work(screen);
  } finally {
    await screen.close();
  }
}

async function shot(vm: string, file: string) {
  await withScreen(vm, async (screen) => {
    writeFileSync(file, await screen.screenshot());
    console.log(`${file} (${screen.width}x${screen.height})`);
  });
}

// The screen only shows its size after the first update, so a click takes a
// frame first; that also lets the pointer land after the desktop has settled.
async function click(
  vm: string,
  x: number,
  y: number,
  { double, right }: { double: boolean; right: boolean },
) {
  await withScreen(vm, async (screen) => {
    await screen.screenshot();
    if (x >= screen.width || y >= screen.height)
      fail(`(${x}, ${y}) is outside the ${screen.width}x${screen.height} screen`);
    const button = right ? 4 : 1;
    screen.move(x, y, 0);
    for (let n = double ? 2 : 1; n > 0; n--) {
      screen.move(x, y, button);
      await sleep(60);
      screen.move(x, y, 0);
      await sleep(60);
    }
    console.log(`${double ? "double-" : right ? "right-" : ""}clicked (${x}, ${y})`);
  });
}

async function type(vm: string, text: string) {
  await withScreen(vm, async (screen) => {
    for (const char of text) {
      const keysym = charKeysym(char),
        shift = needsShift(char);
      if (shift) screen.key(KEYSYMS.shift!, true);
      screen.key(keysym, true);
      screen.key(keysym, false);
      if (shift) screen.key(KEYSYMS.shift!, false);
      await sleep(15);
    }
    console.log(`typed ${text.length} characters`);
  });
}

// `cmd+shift+a`: modifiers held in order, the last key pressed, all released.
async function key(vm: string, combo: string) {
  const names = combo.toLowerCase().split("+").filter(Boolean);
  const keysyms = names.map((name) => {
    const known = KEYSYMS[name] ?? ([...name].length === 1 ? charKeysym(name) : undefined);
    if (known === undefined) fail(`unknown key "${name}" in ${combo}`);
    return known;
  });
  if (!keysyms.length) fail("no key given");
  await withScreen(vm, async (screen) => {
    for (const keysym of keysyms) screen.key(keysym, true);
    await sleep(30);
    for (const keysym of keysyms.toReversed()) screen.key(keysym, false);
    console.log(`pressed ${combo}`);
  });
}

// One-time setup: clone the image, size it, and authorize this host's SSH key
// in the guest (for `--forward`). Stops the VM again only if init started it.
async function init(vm: string, image: string, cpu: number, memory: number) {
  if (findVm(vm)) {
    console.log(`${vm} exists, skipping clone`);
  } else {
    const clone = spawnSync("tart", ["clone", image, vm], { stdio: "inherit" });
    if (clone.status !== 0) fail("tart clone failed");
  }
  const set = tart(["set", vm, "--cpu", String(cpu), "--memory", String(memory)]);
  if (set.status !== 0) fail(`tart set failed: ${set.stderr.trim()}`);
  if (!existsSync(KEY)) {
    mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
    const keygen = spawnSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "mac-vm",
      "-f",
      KEY,
    ]);
    if (keygen.status !== 0) fail("ssh-keygen failed");
  }
  // Always derive the public key from the private one, so a missing or stale
  // .pub (e.g. only the private key was restored) cannot be installed.
  const derive = spawnSync("ssh-keygen", ["-y", "-f", KEY], { encoding: "utf8" });
  if (derive.status !== 0) fail(`could not read ${KEY}: ${derive.stderr.trim()}`);
  writeFileSync(`${KEY}.pub`, derive.stdout);
  await withVm(vm, async (started) => {
    authorizeKey(vm);
    // Leave a VM that was already running (another task may be using it) up.
    if (started) await down(vm, 60);
  });
  console.log(`${vm} ready: ${cpu} CPUs, ${memory} MB, SSH key ${KEY}`);
}

// `tart exec` already runs as the guest user.
function authorizeKey(vm: string) {
  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  const install = tart([
    "exec",
    vm,
    "sh",
    "-c",
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && { grep -qxF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys; } && chmod 600 ~/.ssh/authorized_keys`,
  ]);
  if (install.status !== 0) fail(`authorizing SSH key failed: ${install.stderr.trim()}`);
}

// VM names become log file names, so keep them to one plain path segment.
const vmOption = new Option("--vm <name>", "VM name")
  .env("MAC_VM")
  .default("agent-vm")
  .argParser((name: string) => {
    if (!/^[\w][\w.-]*$/.test(name)) fail(`invalid VM name: ${name}`);
    return name;
  });
const program = new Command("mac-vm").description(
  "On-demand macOS VM for GUI work while the host is locked",
);

program
  .command("init")
  .description("clone and prepare the VM (one-time)")
  .argument("[image]", "OCI image", "ghcr.io/cirruslabs/macos-tahoe-base:latest")
  .addOption(vmOption)
  .option("--cpu <n>", "CPU count", Number, 4)
  .option("--memory <mb>", "memory in MB", Number, 8192)
  .action((image: string, o: { vm: string; cpu: number; memory: number }) =>
    init(o.vm, image, o.cpu, o.memory),
  );

program
  .command("up")
  .description("boot headless and wait for the guest; idempotent")
  .addOption(vmOption)
  .option(
    "--forward <port>",
    "reverse-tunnel a host loopback port into the guest (repeatable)",
    // Validated before boot so a bad port cannot leave a freshly started VM up.
    (v: string, all: number[]) => {
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid --forward port: ${v}`);
      return [...all, port];
    },
    [] as number[],
  )
  .action((o: { vm: string; forward: number[] }) => up(o.vm, o.forward));

program
  .command("down")
  .description("close tunnels and shut the VM down")
  .addOption(vmOption)
  .option(
    "--timeout <s>",
    "seconds before forcing it off",
    (v: string) => {
      const seconds = Number(v);
      if (!Number.isFinite(seconds) || seconds < 0) fail(`invalid --timeout: ${v}`);
      return seconds;
    },
    60,
  )
  .action((o: { vm: string; timeout: number }) => down(o.vm, o.timeout));

const pixel = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`invalid ${name}: ${v}`);
  return n;
};
program
  .command("shot")
  .description("save the guest screen as a PNG; coordinates for click are its pixels")
  .argument("[file]", "output PNG", "/tmp/mac-vm.png")
  .addOption(vmOption)
  .action((file: string, o: { vm: string }) => shot(o.vm, file));

program
  .command("click")
  .description("click at a point on the guest screen")
  .argument("<x>", "pixels from the left", pixel("x"))
  .argument("<y>", "pixels from the top", pixel("y"))
  .addOption(vmOption)
  .option("--double", "double-click")
  .option("--right", "right-click")
  .action((x: number, y: number, o: { vm: string; double?: boolean; right?: boolean }) =>
    click(o.vm, x, y, { double: o.double ?? false, right: o.right ?? false }),
  );

program
  .command("type")
  .description("type text into the guest")
  .argument("<text>")
  .addOption(vmOption)
  .action((text: string, o: { vm: string }) => type(o.vm, text));

program
  .command("key")
  .description("press a key or combination, e.g. enter, cmd+a, cmd+shift+4")
  .argument("<combo>")
  .addOption(vmOption)
  .action((combo: string, o: { vm: string }) => key(o.vm, combo));

program
  .command("status")
  .description("running state, IP, guest agent, VNC, tunnels")
  .addOption(vmOption)
  .option("--json", "machine-readable output")
  .action((o: { vm: string; json?: boolean }) => status(o.vm, o.json ?? false));

await program.parseAsync().catch((error: Error) => {
  console.error(`mac-vm: ${error.message}`);
  process.exit(1);
});
