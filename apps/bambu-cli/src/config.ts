// Settings and secrets for the bambu CLI.
//
// Settings live in ~/.config/bambu/config.json and secrets in the macOS
// Keychain (service "bambu", one account per secret). Environment variables
// override both, under the names bambu-studio-ai documented, so its docs still
// apply to this port. `bambu config` edits all of it; `bambu doctor` checks it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const PROVIDERS = ["meshy", "tripo", "rodin"] as const;

export const Settings = z
  .object({
    model: z.string().min(1),
    printer_ip: z.string().min(1),
    serial: z.string().min(1),
    printer_name: z.string().min(1),
    "3d_provider": z.enum(PROVIDERS),
    rodin_tier: z.string().min(1),
    output_dir: z.string().min(1),
    preferred_format: z.enum(["3mf", "stl", "obj"]),
  })
  .partial();
export type Settings = z.infer<typeof Settings>;
export const SETTING_KEYS = Object.keys(Settings.shape) as (keyof Settings)[];

export const SECRET_KEYS = [
  "access_code",
  "3d_api_key",
  ...PROVIDERS.map((p) => `${p}_api_key` as const),
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

// Environment variable -> the setting or secret it overrides.
export const ENV_KEYS = {
  BAMBU_MODEL: "model",
  BAMBU_IP: "printer_ip",
  BAMBU_SERIAL: "serial",
  BAMBU_ACCESS_CODE: "access_code",
  BAMBU_3D_PROVIDER: "3d_provider",
  BAMBU_3D_API_KEY: "3d_api_key",
} as const satisfies Record<string, keyof Settings | SecretKey>;

export const KEYCHAIN_SERVICE = "bambu";

export interface Keychain {
  read(account: string, service?: string): string | undefined;
  write(account: string, value: string): void;
  remove(account: string): void;
}

// The real Keychain through the `security` CLI. Writes use -U so re-setting a
// secret updates the item instead of failing on the duplicate.
export const macKeychain: Keychain = {
  read(account, service = KEYCHAIN_SERVICE) {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-a", account, "-s", service, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      return undefined;
    }
  },
  write(account, value) {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      value,
    ]);
  },
  remove(account) {
    try {
      execFileSync("security", ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], {
        stdio: "ignore",
      });
    } catch {
      // Nothing to delete.
    }
  },
};

export interface ConfigOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  keychain?: Keychain;
}

// What the printer commands need, resolved from settings, secrets and env.
export interface Printer {
  host: string;
  serial: string;
  accessCode: string;
}

export class ConfigError extends Error {}

// Zod's issue list as one line a person can act on, e.g.
// `3d_provider: Invalid option: expected one of "meshy"|"tripo"|"rodin"`.
function parseSettings(raw: unknown, where?: string): Settings {
  const parsed = Settings.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const detail = `${issue?.path.join(".") || "settings"}: ${issue?.message}`;
  throw new ConfigError(where ? `${where}: ${detail}` : detail);
}

export class Config {
  readonly dir: string;
  readonly file: string;
  readonly legacyFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychain: Keychain;

  constructor({ dir, env = process.env, keychain = macKeychain }: ConfigOptions = {}) {
    this.dir = dir ?? join(homedir(), ".config", "bambu");
    this.file = join(this.dir, "config.json");
    this.legacyFile = join(this.dir, "printer.json");
    this.env = env;
    this.keychain = keychain;
  }

  // Settings as stored, before environment overrides.
  stored(): Settings {
    if (!existsSync(this.file)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      throw new ConfigError(`${this.file} is not valid JSON: ${(error as Error).message}`);
    }
    return parseSettings(raw, this.file);
  }

  // Settings with environment overrides applied.
  settings(): Settings {
    const result: Record<string, string> = { ...this.stored() };
    for (const [envKey, key] of Object.entries(ENV_KEYS)) {
      const value = this.env[envKey];
      if (value && (SETTING_KEYS as string[]).includes(key)) result[key] = value;
    }
    return Settings.parse(result);
  }

  save(settings: Settings): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(Settings.parse(settings), null, 2)}\n`);
  }

  set(updates: Record<string, string>): Settings {
    const next = parseSettings({ ...this.stored(), ...updates });
    this.save(next);
    return next;
  }

  unset(keys: string[]): Settings {
    const next = { ...this.stored() };
    for (const key of keys) delete next[key as keyof Settings];
    this.save(next);
    return next;
  }

  // Environment first, then the Keychain. `3d_api_key` falls back to the key of
  // the configured provider, so either way of storing a provider key works.
  secret(name: SecretKey): string | undefined {
    for (const [envKey, key] of Object.entries(ENV_KEYS)) {
      if (key === name && this.env[envKey]) return this.env[envKey];
    }
    const stored = this.keychain.read(name);
    if (stored) return stored;
    if (name === "3d_api_key") {
      const provider = this.settings()["3d_provider"];
      if (provider) return this.keychain.read(`${provider}_api_key`);
    }
    return undefined;
  }

  setSecret(name: SecretKey, value: string): void {
    this.keychain.write(name, value);
  }

  unsetSecret(name: SecretKey): void {
    this.keychain.remove(name);
  }

  printer(): Printer {
    const { printer_ip: host, serial } = this.settings();
    const accessCode = this.secret("access_code");
    const missing = [
      !host && "printer_ip",
      !serial && "serial",
      !accessCode && "the access_code secret",
    ].filter(Boolean);
    if (missing.length) {
      throw new ConfigError(
        `printer not configured: ${missing.join(", ")} missing. ` +
          `Run \`bambu config set printer_ip <ip> serial <serial>\` and ` +
          `\`bambu config secret access_code\`, or \`bambu config migrate\` for an old printer.json.`,
      );
    }
    return { host: host!, serial: serial!, accessCode: accessCode! };
  }

  // Move a pre-port printer.json ({ host, serial, keychainService }, access
  // code in the Keychain under that service, account "bblp") to config.json
  // and the "bambu" service. Returns what it migrated, or undefined if there
  // was nothing to migrate.
  migrate(): { settings: Settings; accessCode: boolean } | undefined {
    if (!existsSync(this.legacyFile)) return undefined;
    const legacy = z
      .object({ host: z.string(), serial: z.string(), keychainService: z.string() })
      .parse(JSON.parse(readFileSync(this.legacyFile, "utf8")));
    const settings = this.set({ printer_ip: legacy.host, serial: legacy.serial });
    const code = this.keychain.read("bblp", legacy.keychainService);
    if (code) this.setSecret("access_code", code);
    rmSync(this.legacyFile);
    return { settings, accessCode: Boolean(code) };
  }
}

// Mask a secret for display: enough to recognise it, not enough to use it.
export function mask(value: string | undefined): string {
  if (!value) return "(not set)";
  return value.length <= 6 ? "*".repeat(value.length) : `${value.slice(0, 3)}…${value.slice(-2)}`;
}
