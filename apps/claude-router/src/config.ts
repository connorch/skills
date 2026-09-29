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

export const Config = z
  .object({
    port: z.number().int().min(1).max(65535).default(47880),
    // https, or http to loopback for a local mock. Anything else would send
    // tokens in the clear.
    upstream: z
      .url({ protocol: /^https?$/ })
      .superRefine((value, ctx) => {
        const url = new URL(value);
        if (
          url.protocol !== "https:" &&
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ) {
          ctx.addIssue({ code: "custom", message: "http upstreams must be loopback" });
        }
        // Request paths are forwarded as-is, so a prefix would be silently dropped.
        if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
          ctx.addIssue({
            code: "custom",
            message: "upstream must be an origin with no path, query, or fragment",
          });
        }
      })
      .default("https://api.anthropic.com"),
    // Keychain account labels, in the order `status` lists them.
    accounts: z
      .array(z.string().min(1))
      .nonempty()
      .refine((labels) => new Set(labels).size === labels.length, "account labels must be unique")
      .default(["personal", "personal_2", "work"]),
    // The bucket whose reset time ranks accounts (D4).
    rankBucket: z.string().default("7d"),
    // Utilization at which an account moves to the back of the ranking.
    demoteAt: z.number().min(0).max(1).default(0.95),
    // A session pin lapses after this much idle time (D7).
    pinIdleMs: z.number().int().positive().default(3_600_000),
    // Claude Code entrypoints (from the user-agent) that are forwarded with
    // their own auth instead of being routed (D11).
    passthroughEntrypoints: z.array(z.string()).default(["claude-desktop"]),
  })
  .refine((config) => {
    const url = new URL(config.upstream);
    return url.protocol === "https:" || Number(url.port || 80) !== config.port;
  }, "upstream must not be the router itself");
export type Config = z.infer<typeof Config>;

export function loadConfig(path = CONFIG_PATH): Config {
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return Config.parse(raw);
}

export const routerUrl = (config: Pick<Config, "port">) => `http://127.0.0.1:${config.port}`;
