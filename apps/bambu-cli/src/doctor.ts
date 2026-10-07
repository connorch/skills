// `bambu doctor`: is this Machine set up to find, check, slice and print?
// Every check is local except a TCP probe of the printer's MQTT port (and of
// the router, when the printer is unreachable), which tells a printer that is
// off from a process macOS has cut off from the LAN.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { type Config, ConfigError, mask, PROVIDERS } from "./config.ts";
import { findCli, findProfilesDir } from "./slice/discovery.ts";
import { printer, printers } from "./mesh/hardware.ts";
import { PROFILES, STUDIO } from "./studio.ts";

type Level = "ok" | "warn" | "missing" | "info";

export interface Finding {
  level: Level;
  text: string;
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", missing: "✗", info: "·" };

// What one TCP connection attempt learned: "refused" still means the host is
// there, "unreachable" is the kernel refusing to route to it, "silent" is a
// timeout or anything else.
export type Reach = "open" | "refused" | "unreachable" | "silent";
export interface Network {
  reach(host: string, port: number): Promise<Reach>;
  gateway(): string | undefined;
}
const PRINTER_PORT = 8883;
export const localNetwork: Network = {
  reach: (host, port) =>
    new Promise((done) => {
      const socket = connect({ host, port });
      const finish = (result: Reach) => {
        socket.destroy();
        done(result);
      };
      socket.setTimeout(3000, () => finish("silent"));
      socket.on("connect", () => finish("open"));
      socket.on("error", (error: NodeJS.ErrnoException) =>
        finish(
          error.code === "ECONNREFUSED"
            ? "refused"
            : ["EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN"].includes(error.code ?? "")
              ? "unreachable"
              : "silent",
        ),
      );
    }),
  gateway() {
    try {
      return execFileSync("route", ["-n", "get", "default"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).match(/gateway: (\S+)/)?.[1];
    } catch {
      return undefined;
    }
  },
};

// A printer the kernel will not route to while the router answers is the
// macOS Local Network permission: it is granted per app, and a terminal or
// agent host without it gets EHOSTUNREACH for every LAN peer.
async function printerReach(ip: string, net: Network): Promise<Finding> {
  const reach = await net.reach(ip, PRINTER_PORT);
  if (reach === "open") return { level: "ok", text: `Printer answers at ${ip}:${PRINTER_PORT}` };
  if (reach === "refused")
    return {
      level: "warn",
      text: `${ip} answers but nothing listens on port ${PRINTER_PORT}; is that the printer's address?`,
    };
  if (reach === "silent")
    return {
      level: "warn",
      text: `No answer from ${ip}; the printer may be off, or the address may be wrong`,
    };
  const gateway = net.gateway(),
    router = gateway ? await net.reach(gateway, 80) : "unreachable";
  return router === "open" || router === "refused"
    ? {
        level: "missing",
        text: `${ip} is unreachable while the router at ${gateway} answers: the app running bambu lacks macOS Local Network permission. Enable it under System Settings > Privacy & Security > Local Network for the terminal or agent host, then restart that app.`,
      }
    : {
        level: "warn",
        text: `${ip} is unreachable and so is the router; check this Mac's network connection`,
      };
}

function onPath(command: string): string | undefined {
  try {
    return execFileSync("which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// Bambu Studio's version from the app bundle holding the CLI binary.
function studioVersion(cli: string): string | undefined {
  try {
    const plist = readFileSync(`${dirname(dirname(cli))}/Info.plist`, "utf8");
    return plist.match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1];
  } catch {
    return undefined;
  }
}

export async function diagnose(config: Config, net: Network = localNetwork): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (level: Level, text: string) => findings.push({ level, text });

  // The same discovery slice uses, so BAMBU_STUDIO_CLI / BAMBU_STUDIO_PROFILES apply.
  const cli = findCli()?.[0];
  const version = cli ? studioVersion(cli) : undefined;
  if (cli && version && /^02\.05\.0[01](\.|$)/.test(version))
    add(
      "missing",
      `Bambu Studio ${version} at ${cli} crashes in command-line mode; update to 02.05.02 or newer.`,
    );
  else if (cli) add("ok", `Bambu Studio ${version ?? "(version unknown)"} at ${cli}`);
  else
    add(
      "missing",
      `Bambu Studio not found at ${STUDIO}; install it from bambulab.com/en/download/studio`,
    );
  const profiles = findProfilesDir(cli ? [cli] : undefined);
  if (profiles) add("ok", `Slicing profiles at ${profiles}`);
  else add("missing", `No slicing profiles at ${PROFILES}`);

  const macVm = onPath("mac-vm");
  if (macVm) add("ok", `mac-vm at ${macVm} (starts prints through Bambu Connect)`);
  else add("warn", "mac-vm not on PATH; prints cannot be started from this Machine");

  let settings;
  try {
    settings = config.settings();
    add(existsSync(config.file) ? "ok" : "info", `Settings at ${config.file}`);
  } catch (error) {
    add("missing", error instanceof ConfigError ? error.message : String(error));
    return findings;
  }
  if (existsSync(config.legacyFile)) {
    add("warn", `Old printer.json at ${config.legacyFile}; run \`bambu config migrate\``);
  }

  const { model, printer_ip: ip, serial } = settings;
  if (ip && serial) add("ok", `Printer ${model ?? "(model not set)"} at ${ip}, serial ${serial}`);
  else add("missing", "Printer not set; run `bambu config set printer_ip <ip> serial <serial>`");
  if (ip) findings.push(await printerReach(ip, net));
  if (!model) add("warn", "Printer model not set; run `bambu config set model P1S`");
  else
    try {
      printer(model);
    } catch {
      add(
        "missing",
        `Unknown printer model "${model}"; known: ${printers.map((p) => p.key).join(", ")}. Run \`bambu config set model <model>\``,
      );
    }

  const code = config.secret("access_code");
  if (code) add("ok", `Access code ${mask(code)}`);
  else add("missing", "No access code; run `bambu config secret access_code`");

  const provider = settings["3d_provider"];
  const providerKey = config.secret("3d_api_key");
  if (provider && providerKey)
    add("ok", `AI generation through ${provider}, key ${mask(providerKey)}`);
  else if (provider)
    add("warn", `No API key for ${provider}; run \`bambu config secret ${provider}_api_key\``);
  else add("info", `No AI generation provider set (optional: ${PROVIDERS.join(", ")})`);

  return findings;
}

export function report(findings: Finding[]): { text: string; ok: boolean } {
  const text = findings.map((f) => `${MARK[f.level]} ${f.text}`).join("\n");
  return { text, ok: !findings.some((f) => f.level === "missing") };
}
