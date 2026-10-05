// `bambu doctor`: is this Machine set up to find, check, slice and print?
// Every check is local and offline; nothing here talks to the printer.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type Config, ConfigError, mask, PROVIDERS } from "./config.ts";
import { PROFILES, STUDIO, STUDIO_CLI } from "./studio.ts";

type Level = "ok" | "warn" | "missing" | "info";

export interface Finding {
  level: Level;
  text: string;
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", missing: "✗", info: "·" };

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

function studioVersion(): string | undefined {
  try {
    const plist = readFileSync(`${STUDIO}/Contents/Info.plist`, "utf8");
    return plist.match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1];
  } catch {
    return undefined;
  }
}

export function diagnose(config: Config): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Level, text: string) => findings.push({ level, text });

  if (existsSync(STUDIO_CLI)) {
    add("ok", `Bambu Studio ${studioVersion() ?? "(version unknown)"} at ${STUDIO}`);
  } else {
    add(
      "missing",
      `Bambu Studio not found at ${STUDIO}; install it from bambulab.com/en/download/studio`,
    );
  }
  if (existsSync(PROFILES)) add("ok", `Slicing profiles at ${PROFILES}`);
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
  if (!model) add("warn", "Printer model not set; run `bambu config set model P1S`");

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
