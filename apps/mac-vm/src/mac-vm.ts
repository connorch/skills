// mac-vm - start and stop an on-demand macOS VM (Tart) so an agent can use GUI
// apps while the host Mac is locked. The agent-facing guide is
// skills/mac-vm/SKILL.md.
//
// The VM is off by default: `up` boots it headless, `down` shuts it off. Run
// commands and copy files with `tart exec` (the Cirrus images ship its guest
// agent). SSH is only used for `--forward`, which reverse-tunnels host
// loopback ports into the guest so apps there can reach host-only services.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command, Option } from "commander";

const STATE_DIR = join(homedir(), ".local", "state", "mac-vm");
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

// What `up` started, so `down` and `status` can find it again.
interface State {
  tunnels: { port: number; pid: number }[];
}

// Throws rather than exiting, so `up` can roll back a VM it started; the
// entry point prints the message and exits 1.
function fail(message: string): never {
  throw new Error(message);
}

// Time-boxed so a wedged guest agent cannot outlast the callers' own deadlines.
function tart(...args: string[]) {
  return spawnSync("tart", args, { encoding: "utf8", timeout: 30_000 });
}

function statePath(vm: string) {
  return join(STATE_DIR, `${vm}.json`);
}

function readState(vm: string): State {
  try {
    return JSON.parse(readFileSync(statePath(vm), "utf8")) as State;
  } catch {
    return { tunnels: [] };
  }
}

// The local VM's entry in `tart list`, if it exists.
function findVm(vm: string) {
  const list = tart("list", "--format", "json");
  if (list.status !== 0) fail(`tart list failed: ${list.stderr.trim()}`);
  const vms = JSON.parse(list.stdout) as { Name: string; Source: string; Running: boolean }[];
  return vms.find((v) => v.Source === "local" && v.Name === vm);
}

function isRunning(vm: string): boolean {
  const found = findVm(vm);
  if (!found) fail(`no VM named ${vm} (see \`tart list\`, or run \`mac-vm init\`)`);
  return found.Running;
}

// True if `pid` is still the reverse tunnel `up` started for `port`. PIDs in
// the state file can outlive their process (host reboot, killed CLI) and get
// reused, so check the command line before trusting or killing one.
function isTunnel({ pid, port }: { pid: number; port: number }): boolean {
  const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes(`-R ${port}:127.0.0.1:${port}`);
}

// Poll `probe` once a second until it passes or `seconds` run out.
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
  const result = spawnSync("tart", ["ip", vm, "--wait", String(BOOT_TIMEOUT_S)], {
    encoding: "utf8",
    timeout: (BOOT_TIMEOUT_S + 10) * 1000,
  });
  if (result.status !== 0) fail(`no IP for ${vm}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// Boot headless if needed, then wait until `tart exec` works (the guest has
// logged in and its agent is up).
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

async function boot(vm: string, start: boolean) {
  if (start) {
    mkdirSync(STATE_DIR, { recursive: true });
    const log = openSync(join(STATE_DIR, `${vm}.log`), "a");
    spawn("tart", ["run", "--no-graphics", vm], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  }
  // The guest agent can answer before auto-login finishes; wait for a console user.
  const loggedIn = () =>
    tart("exec", vm, "sh", "-c", '[ "$(stat -f %Su /dev/console)" != root ]').status === 0;
  if (!(await waitFor(BOOT_TIMEOUT_S, loggedIn)))
    fail(`timed out after ${BOOT_TIMEOUT_S}s waiting for the guest desktop login`);
}

function up(vm: string, user: string, forwards: number[]) {
  return withVm(vm, () => forward(vm, user, forwards));
}

async function forward(vm: string, user: string, forwards: number[]) {
  const address = ip(vm);
  for (const port of forwards) {
    if (readState(vm).tunnels.some((t) => t.port === port && isTunnel(t))) continue;
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
        `${user}@${address}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    ssh.unref();
    // Ready once the port answers inside the guest, not just once ssh is running.
    const tunnel = { pid: ssh.pid ?? -1, port };
    const ready = await waitFor(20, () => {
      if (!isTunnel(tunnel))
        fail(`reverse tunnel for port ${port} exited (was \`mac-vm init\` run?)`);
      return tart("exec", vm, "nc", "-z", "127.0.0.1", String(port)).status === 0;
    });
    if (!ready) {
      process.kill(tunnel.pid);
      fail(`reverse tunnel for port ${port} never became reachable in the guest`);
    }
    // Record each tunnel as it comes up, so `down` can still close it if a later
    // one fails. Re-read first so a concurrent `up` for another port is kept.
    mkdirSync(STATE_DIR, { recursive: true });
    const latest = readState(vm);
    latest.tunnels = [...latest.tunnels.filter((t) => t.port !== port), tunnel];
    writeFileSync(statePath(vm), JSON.stringify(latest));
  }
  console.log(
    `${vm} up at ${address}${forwards.length ? `, forwarding ${forwards.join(", ")}` : ""}`,
  );
}

// Shut down from inside the guest so it flushes its disk: `tart stop` alone
// can force the VM off and lose recent writes. Falls back to `tart stop` if
// the guest agent is unreachable or the shutdown hangs.
async function down(vm: string, timeout: number) {
  for (const t of readState(vm).tunnels) {
    if (!isTunnel(t)) continue;
    try {
      process.kill(t.pid);
    } catch (error) {
      // Already gone between the check and the kill: that is closed.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  rmSync(statePath(vm), { force: true });
  if (isRunning(vm)) {
    // Bounded: a wedged guest agent must not block the `tart stop` fallback.
    spawnSync("tart", ["exec", vm, "sudo", "-n", "shutdown", "-h", "now"], { timeout: 15_000 });
    await waitFor(timeout, () => !isRunning(vm));
    if (isRunning(vm)) {
      const result = tart("stop", vm, "--timeout", "5");
      if (result.status !== 0) fail(`tart stop failed: ${result.stderr.trim()}`);
    }
  }
  console.log(`${vm} down`);
}

function status(vm: string, json: boolean) {
  const running = isRunning(vm);
  const report = {
    vm,
    running,
    ip: running ? tart("ip", vm).stdout.trim() || null : null,
    guestAgent: running && tart("exec", vm, "true").status === 0,
    tunnels: readState(vm).tunnels.map((t) => ({ ...t, alive: isTunnel(t) })),
  };
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(`${vm}: ${running ? `running at ${report.ip ?? "?"}` : "stopped"}`);
  if (running) console.log(`guest agent: ${report.guestAgent ? "ready" : "not ready"}`);
  for (const t of report.tunnels) console.log(`tunnel ${t.port}: ${t.alive ? "up" : "dead"}`);
}

// One-time setup: clone the image, size it, and authorize this host's SSH key
// in the guest (for `--forward`). Stops the VM again only if init started it.
async function init(vm: string, image: string, cpu: number, memory: number, user: string) {
  if (findVm(vm)) {
    console.log(`${vm} exists, skipping clone`);
  } else {
    const clone = spawnSync("tart", ["clone", image, vm], { stdio: "inherit" });
    if (clone.status !== 0) fail("tart clone failed");
  }
  const set = tart("set", vm, "--cpu", String(cpu), "--memory", String(memory));
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
  } else if (!existsSync(`${KEY}.pub`)) {
    // Private key without its sidecar (e.g. restored alone): derive it.
    const derive = spawnSync("ssh-keygen", ["-y", "-f", KEY], { encoding: "utf8" });
    if (derive.status !== 0) fail(`could not derive ${KEY}.pub: ${derive.stderr.trim()}`);
    writeFileSync(`${KEY}.pub`, derive.stdout);
  }
  await withVm(vm, async (started) => {
    authorizeKey(vm, user);
    // Leave a VM that was already running (another task may be using it) up.
    if (started) await down(vm, 60);
  });
  console.log(`${vm} ready: ${cpu} CPUs, ${memory} MB, SSH key ${KEY}`);
}

function authorizeKey(vm: string, user: string) {
  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  const home = user === "root" ? "/var/root" : `/Users/${user}`;
  const install = tart(
    "exec",
    vm,
    "sudo",
    "-n",
    "-u",
    user,
    "sh",
    "-c",
    `mkdir -p ${home}/.ssh && chmod 700 ${home}/.ssh && grep -qxF '${pub}' ${home}/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ${home}/.ssh/authorized_keys; chmod 600 ${home}/.ssh/authorized_keys`,
  );
  if (install.status !== 0) fail(`authorizing SSH key failed: ${install.stderr.trim()}`);
}

// VM names become state file names, so keep them to one plain path segment.
const vmOption = new Option("--vm <name>", "VM name")
  .env("MAC_VM")
  .default("agent-vm")
  .argParser((name: string) => {
    if (!/^[\w][\w.-]*$/.test(name)) fail(`invalid VM name: ${name}`);
    return name;
  });
const userOption = new Option("--user <name>", "guest user").default("admin");
const program = new Command("mac-vm").description(
  "On-demand macOS VM for GUI work while the host is locked",
);

program
  .command("init")
  .description("clone and prepare the VM (one-time)")
  .argument("[image]", "OCI image", "ghcr.io/cirruslabs/macos-tahoe-base:latest")
  .addOption(vmOption)
  .addOption(userOption)
  .option("--cpu <n>", "CPU count", Number, 4)
  .option("--memory <mb>", "memory in MB", Number, 8192)
  .action((image: string, o: { vm: string; user: string; cpu: number; memory: number }) =>
    init(o.vm, image, o.cpu, o.memory, o.user),
  );

program
  .command("up")
  .description("boot headless and wait for the guest; idempotent")
  .addOption(vmOption)
  .addOption(userOption)
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
  .action((o: { vm: string; user: string; forward: number[] }) => up(o.vm, o.user, o.forward));

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

program
  .command("status")
  .description("running state, IP, guest agent, tunnels")
  .addOption(vmOption)
  .option("--json", "machine-readable output")
  .action((o: { vm: string; json?: boolean }) => status(o.vm, o.json ?? false));

await program.parseAsync().catch((error: Error) => {
  console.error(`mac-vm: ${error.message}`);
  process.exit(1);
});
