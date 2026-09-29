// Router configuration and well-known paths. Every value has a default, so
// ~/.config/claude-router/config.json is optional and usually absent.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_PATH = join(homedir(), ".config", "claude-router", "config.json");
export const STATE_DIR = join(homedir(), ".local", "state", "claude-router");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const REQUEST_LOG_PATH = join(STATE_DIR, "requests.jsonl");
export const SERVICE_LOG_PATH = join(STATE_DIR, "service.log");

export const Config = z.object({
  port: z.number().int().positive().default(47880),
  // https, or http for a local mock. Anything else would send tokens in the clear.
  upstream: z.url({ protocol: /^https?$/ }).default("https://api.anthropic.com"),
  // Keychain account labels, in the order `status` lists them.
  accounts: z.array(z.string().min(1)).nonempty().default(["personal", "personal_2", "work"]),
  // The bucket whose reset time ranks accounts (D4).
  rankBucket: z.string().default("7d"),
  // Utilization at which an account moves to the back of the ranking.
  demoteAt: z.number().min(0).max(1).default(0.95),
  // A session pin lapses after this much idle time (D7).
  pinIdleMs: z.number().int().positive().default(3_600_000),
  // Claude Code entrypoints (from the user-agent) that are forwarded with
  // their own auth instead of being routed (D11).
  passthroughEntrypoints: z.array(z.string()).default(["claude-desktop"]),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path = CONFIG_PATH): Config {
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return Config.parse(raw);
}

export const routerUrl = (config: Pick<Config, "port">) => `http://127.0.0.1:${config.port}`;
