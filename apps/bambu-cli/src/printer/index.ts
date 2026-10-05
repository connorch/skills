import type { Command } from "commander";
import { ConfigError, type Config } from "../config.ts";
import { output } from "../cli.ts";
import { PrinterAuthError, readReport, type ReportReader } from "./client.ts";
import type { Event } from "./events.ts";
import { defaultWatchDependencies, limitsFor, watch } from "./monitor.ts";
import { formatStatus, formatTrays, parseStatus } from "./report.ts";
export * from "./report.ts";
export * from "./client.ts";
export * from "./events.ts";
export * from "./monitor.ts";
export const AUTO_PAUSE_REMOVED =
  "--auto-pause was removed in v2.1: pausing needs LAN Only + Developer Mode, which disconnects Bambu Handy. The monitor alerts you instead; pause from the printer screen or Bambu Handy.";
export function printerInfo(config: Config) {
  const settings = config.settings(),
    accessCode = config.secret("access_code"),
    serial = settings.serial || "";
  const missing = [
    !settings.printer_ip && "printer_ip",
    !serial && "serial",
    !accessCode && "access_code",
  ].filter((v): v is string => typeof v === "string");
  return {
    model: settings.model || null,
    printer_ip: settings.printer_ip || null,
    serial: serial.length > 8 ? `${serial.slice(0, 4)}…${serial.slice(-3)}` : null,
    access_code_set: Boolean(accessCode),
    configured: !missing.length,
    missing,
  };
}
export function formatInfo(info: ReturnType<typeof printerInfo>) {
  return [
    `Model:       ${info.model || "not set"}`,
    `Printer IP:  ${info.printer_ip || "not set"}`,
    `Serial:      ${info.serial || "not set"}`,
    `Access code: ${info.access_code_set ? "set" : "not set"}`,
    ...(info.missing.length
      ? [`To read status, set: ${info.missing.join(", ")} (bambu config)`]
      : []),
  ].join("\n");
}
function commandError(error: unknown, json: boolean) {
  const detail = error instanceof Error ? error.message : String(error);
  const message =
    error instanceof PrinterAuthError
      ? `${detail}. Check the access code on the printer (Settings → Network).`
      : detail;
  const type =
    error instanceof ConfigError
      ? "not_configured"
      : error instanceof PrinterAuthError
        ? "auth"
        : error instanceof RangeError
          ? "usage"
          : "unreachable";
  if (json) output(true, { error: { type, message } }, () => "");
  console.error(`bambu: ${message}`);
  process.exitCode = type === "not_configured" || type === "usage" ? 2 : 1;
}
// Read operation shared with callers that supply an offline report source.
export async function fetchStatus(config: Config, read: ReportReader = readReport) {
  return parseStatus(await read(config.printer()));
}
// Register read-only commands; CLI integration is owned by the caller.
export function register(program: Command, config: Config): void {
  program
    .command("info")
    .description("configured printer, without connecting")
    .option("--json")
    .action((options: { json?: boolean }) => {
      try {
        const info = printerInfo(config);
        output(Boolean(options.json), info, () => formatInfo(info));
      } catch (error) {
        commandError(error, Boolean(options.json));
      }
    });
  for (const name of ["status", "ams"] as const)
    program
      .command(name)
      .description(
        name === "status" ? "printer state, temperatures and loaded filaments" : "loaded filaments",
      )
      .option("--json")
      .action(async (options: { json?: boolean }) => {
        try {
          const status = await fetchStatus(config),
            model = config.settings().model;
          output(
            Boolean(options.json),
            name === "status"
              ? { schema: 1, model: model || null, ...status }
              : { schema: 1, trays: status.trays },
            () => (name === "status" ? formatStatus(status, model) : formatTrays(status.trays)),
          );
        } catch (error) {
          commandError(error, Boolean(options.json));
        }
      });
  program
    .command("watch")
    .description("watch a Print Job and announce changes")
    .option("--interval <seconds>", "seconds between checks", "120")
    .option("--wait-start <minutes>", "wait for a print to start", "0")
    .option("--once", "one check with persisted state")
    .option("--json")
    .option("--auto-pause", "removed; alerts only")
    .action(
      async (options: {
        interval: string;
        waitStart: string;
        once?: boolean;
        json?: boolean;
        autoPause?: boolean;
      }) => {
        const events: Event[] = [];
        try {
          if (options.autoPause) throw new RangeError(AUTO_PAUSE_REMOVED);
          const interval = Number(options.interval),
            waitStart = Number(options.waitStart);
          if (!Number.isInteger(interval) || interval < 10)
            throw new RangeError("--interval must be at least 10 seconds");
          if (!/^\d+$/.test(options.waitStart) || !Number.isSafeInteger(waitStart))
            throw new RangeError("--wait-start must be a whole number of minutes");
          const deps = defaultWatchDependencies(
            config.dir,
            config.settings().output_dir,
            (event) => {
              if (options.json) events.push(event);
              if (!options.json) console.log(`\u{1F4E2} NOTIFY: ${event.title} - ${event.message}`);
            },
          );
          process.exitCode = await watch(
            config.printer(),
            limitsFor(config.settings().model),
            { interval, waitStart, once: Boolean(options.once) },
            deps,
          );
          if (options.json) output(true, { events }, () => "");
        } catch (error) {
          commandError(error, Boolean(options.json));
        }
      },
    );
}
