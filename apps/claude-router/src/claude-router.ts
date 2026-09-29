// claude-router - route Claude Code inference across several subscription
// accounts. The agent-facing guide is skills/claude-router/SKILL.md; the
// design is the plan linked from apps/claude-router/README.md.
//
//   serve                 the proxy (run by the LaunchAgent)
//   status                accounts, buckets, ranking, pins
//   on / off              add or remove the router from ~/.claude/settings.json
//   accounts sync         1Password -> Keychain, then reload the service
//   accounts import-openclaw   one-time OpenClaw -> 1Password
//   service install|uninstall  the LaunchAgent (install is run by ship:machine)

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  importOpenClaw,
  readKeychainAccounts,
  syncFromOnePassword,
  type Account,
} from "./accounts.ts";
import { loadConfig, REQUEST_LOG_PATH, routerUrl, STATE_PATH, type Config } from "./config.ts";
import { createRouter, type Status } from "./server.ts";
import { installService, PLIST_PATH, startService, stopService } from "./service.ts";
import {
  BASE_URL_KEY,
  currentBaseUrl,
  diff,
  SETTINGS_PATH,
  withoutRouter,
  withRouter,
} from "./settings.ts";
import { RequestLog, RouterState } from "./state.ts";

// Temp file plus rename: a failed write leaves settings.json untouched. A
// symlinked settings.json (dotfile-managed) is replaced at its target.
function writeSettings(text: string): void {
  const exists = existsSync(SETTINGS_PATH);
  const target = exists ? realpathSync(SETTINGS_PATH) : SETTINGS_PATH;
  const mode = exists ? statSync(target).mode & 0o777 : 0o644;
  writeFileSync(`${target}.tmp`, text, { mode });
  renameSync(`${target}.tmp`, target);
}

const program = new Command()
  .name("claude-router")
  .description("route Claude Code across subscription accounts");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function health(config: Config): Promise<{ ok: boolean; accounts: string[] } | null> {
  try {
    const res = await fetch(`${routerUrl(config)}/health`);
    return res.ok ? ((await res.json()) as { ok: boolean; accounts: string[] }) : null;
  } catch {
    return null;
  }
}

program
  .command("serve")
  .description("run the proxy on 127.0.0.1")
  .action(() => {
    const config = loadConfig();
    let accounts: Account[] = [];
    const read = () => {
      const found = readKeychainAccounts(config.accounts);
      accounts = found.accounts;
      for (const label of found.missing) console.error(`no Keychain token for ${label}`);
    };
    // After `accounts sync`: a fresh token clears a 401 from the old one. A
    // plain restart keeps the 401 until then.
    const reload = (synced: string[]) => {
      read();
      for (const label of synced) state.account(label).broken = null;
    };
    const state = RouterState.load(STATE_PATH);
    read();
    const log = new RequestLog(REQUEST_LOG_PATH);
    const server = createRouter({ config, accounts: () => accounts, reload, state, log });
    server.listen(config.port, "127.0.0.1", () => {
      console.log(
        `claude-router listening on ${routerUrl(config)} with ${accounts.length} account(s)`,
      );
    });
    // Save now and again once in-flight requests have drained, so what
    // they learned is not lost across a restart.
    const stop = () => {
      state.save();
      server.close(() => {
        state.save();
        process.exit(0);
      });
      setTimeout(() => {
        state.save();
        process.exit(0);
      }, 2000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });

const pct = (n: number) => `${Math.round(n * 100)}%`;
const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

program
  .command("status")
  .description("accounts, buckets, ranking per model, and active pins")
  .option("--json", "raw status JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const res = await fetch(`${routerUrl(config)}/_router/status`).catch(() => null);
    if (!res?.ok)
      fail(
        `claude-router is not running at ${routerUrl(config)} (pnpm ship:machine installs the service)`,
      );
    const status = (await res.json()) as Status;
    if (opts.json) return console.log(JSON.stringify(status, null, 2));

    const settings = existsSync(SETTINGS_PATH)
      ? currentBaseUrl(readFileSync(SETTINGS_PATH, "utf8"))
      : null;
    console.log(
      `settings.json: ${settings === routerUrl(config) ? "routed through claude-router" : "direct (run `claude-router on`)"}`,
    );
    for (const label of status.missing)
      console.log(`! no Keychain token for ${label} (run \`claude-router accounts sync\`)`);
    const buckets = [...new Set(status.accounts.flatMap((a) => Object.keys(a.buckets)))].sort();
    const now = Date.parse(status.now);
    console.log(
      [
        "account".padEnd(12),
        "token".padEnd(12),
        "state".padEnd(22),
        ...buckets.map((b) => b.padEnd(24)),
      ].join(""),
    );
    for (const account of status.accounts) {
      const expires = account.expires
        ? new Date(account.expires).toISOString().slice(0, 10)
        : "unknown";
      const expiring =
        account.expires !== null && account.expires - now < 30 * 86_400_000 ? "!" : " ";
      const state = account.broken
        ? `broken (${account.broken.reason})`
        : account.bench && account.bench.until > now
          ? `bench ${account.bench.reason} -> ${when(account.bench.until)}`
          : "ok";
      const cells = buckets.map((name) => {
        const b = account.buckets[name];
        if (!b || b.resetAt <= now) return "-".padEnd(24);
        const flag =
          b.status === "allowed" || b.status === "allowed_warning"
            ? ""
            : ` ${b.status.toUpperCase()}`;
        return `${pct(b.utilization)}${flag} -> ${when(b.resetAt)}`.padEnd(24);
      });
      console.log(
        [
          account.label.padEnd(12),
          `${expires}${expiring}`.padEnd(12),
          state.padEnd(22),
          ...cells,
        ].join(""),
      );
    }
    console.log("\nranking");
    for (const [model, { order, candidates }] of Object.entries(status.ranking)) {
      const out = candidates
        .filter((c) => !c.eligible)
        .map((c) => `${c.label} (${c.why ?? "ineligible"})`);
      const demoted = candidates.filter((c) => c.eligible && c.demoted).map((c) => c.label);
      console.log(
        `  ${model}: ${order.join(" > ") || "none"}${demoted.length ? `  demoted: ${demoted.join(", ")}` : ""}${out.length ? `  out: ${out.join(", ")}` : ""}`,
      );
    }
    const byAccount = new Map<string, number>();
    for (const pin of status.pins) byAccount.set(pin.label, (byAccount.get(pin.label) ?? 0) + 1);
    console.log(
      `\npins: ${status.pins.length} active${byAccount.size ? ` (${[...byAccount].map(([l, n]) => `${l} ${n}`).join(", ")})` : ""}`,
    );
  });

program
  .command("on")
  .description("point ~/.claude/settings.json at the router (shows the diff, asks first)")
  .option("-y, --yes", "apply without asking")
  .action(async (opts: { yes?: boolean }) => {
    const config = loadConfig();
    const before = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf8") : "";
    const after = withRouter(before, routerUrl(config));
    const configured = currentBaseUrl(before) === routerUrl(config);
    if (configured) console.log(`${SETTINGS_PATH} already routes through claude-router`);
    else {
      console.log(`${SETTINGS_PATH}:`);
      for (const line of diff(before, after)) console.log(`  ${line}`);
    }
    if (!configured && !opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("apply? [y/N] ");
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return console.log("left unchanged");
    }

    // Only now touch the service: a "no" above must leave it as it was.
    let up = await health(config);
    if (!up && existsSync(PLIST_PATH) && startService()) {
      await sleep(1500);
      up = await health(config);
    }
    if (!up)
      fail(`claude-router is not running at ${routerUrl(config)}; run pnpm ship:machine first`);
    if (up.accounts.length === 0)
      console.log(
        "warning: no accounts in the Keychain; the router will pass everything through until `accounts sync` runs",
      );
    if (configured) return console.log("service running");
    writeSettings(after);
    console.log(
      "applied. new Claude Code sessions go through claude-router; `claude-router off` reverts.",
    );
  });

program
  .command("off")
  .description(`remove env.${BASE_URL_KEY} from ~/.claude/settings.json and stop the service`)
  .action(() => {
    if (existsSync(SETTINGS_PATH)) {
      const before = readFileSync(SETTINGS_PATH, "utf8");
      const after = withoutRouter(before);
      if (after === before) console.log("settings.json: nothing to remove");
      else {
        writeSettings(after);
        console.log(`settings.json: removed env.${BASE_URL_KEY}`);
      }
    }
    stopService();
    console.log("service stopped. `claude-router on` or pnpm ship:machine brings it back.");
  });

const accounts = program.command("accounts").description("token management");

accounts
  .command("sync")
  .description("copy tokens from 1Password into the Keychain and reload the service")
  .action(async () => {
    const config = loadConfig();
    const result = syncFromOnePassword(config.accounts);
    for (const label of result.synced) console.log(`synced ${label}`);
    for (const { label, error } of result.failed) console.error(`failed ${label}: ${error}`);
    const reload = await fetch(`${routerUrl(config)}/_router/reload`, {
      method: "POST",
      body: JSON.stringify({ synced: result.synced }),
    }).catch(() => null);
    if (reload?.ok) console.log("service reloaded");
    else {
      // Startup keeps a persisted 401 on purpose, so clear it here for the
      // tokens that just changed. Nothing else writes the file while the
      // service is down.
      const state = RouterState.load(STATE_PATH);
      for (const label of result.synced) state.account(label).broken = null;
      if (!state.save()) fail("could not write the persisted state; the 401 marks are unchanged");
      console.log("service not running; it will read the Keychain on start");
    }
    if (result.failed.length > 0) process.exit(1);
  });

accounts
  .command("import-openclaw")
  .description("one-time: copy OpenClaw's setup tokens into 1Password items claude-router/<label>")
  .option("--dry-run", "show what would be created, create nothing")
  .action((opts: { dryRun?: boolean }) => {
    const config = loadConfig();
    const result = importOpenClaw(config.accounts, Boolean(opts.dryRun));
    for (const { label, email, expires } of result.done) {
      console.log(
        `${opts.dryRun ? "would create" : "created"} ${label}: email ${email ?? "unknown"}, expires ${expires ?? "unknown"}`,
      );
    }
    for (const { label, error } of result.failed) console.error(`failed ${label}: ${error}`);
    if (result.failed.length > 0) process.exit(1);
  });

const service = program.command("service").description("the LaunchAgent");

service
  .command("install")
  .description("write the LaunchAgent for this binary and (re)start it")
  .action(() => {
    const bin = process.argv[1];
    if (!bin) fail("cannot determine the claude-router binary path");
    installService(process.execPath, bin);
    console.log(`installed ${PLIST_PATH}`);
  });

service
  .command("uninstall")
  .description("stop the LaunchAgent")
  .action(() => {
    stopService();
    console.log("stopped");
  });

program.parseAsync().catch((error: Error) => fail(error.message));
