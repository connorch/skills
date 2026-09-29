// Account tokens. 1Password is the source of truth (D8); `accounts sync`
// copies each item into the login Keychain, and the running service reads
// only the Keychain. Tokens never touch stdout, argv beyond `security`, or logs.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Account {
  label: string;
  token: string;
  // Epoch ms, when the setup token expires; null if unknown.
  expires: number | null;
}

const SERVICE = "claude-router";
const VAULT = "Private";
const itemTitle = (label: string) => `${SERVICE}/${label}`;

interface KeychainValue {
  token: string;
  expires: number | null;
}

function security(args: string[]) {
  return spawnSync("security", args, { encoding: "utf8" });
}

// Every configured label that has a Keychain item, plus the ones that do not.
export function readKeychainAccounts(labels: readonly string[]): {
  accounts: Account[];
  missing: string[];
} {
  const accounts: Account[] = [];
  const missing: string[] = [];
  for (const label of labels) {
    const result = security(["find-generic-password", "-s", SERVICE, "-a", label, "-w"]);
    if (result.status !== 0) {
      missing.push(label);
      continue;
    }
    try {
      const value = JSON.parse(result.stdout.trim()) as KeychainValue;
      if (typeof value.token !== "string" || value.token.length === 0) throw new Error("no token");
      accounts.push({ label, token: value.token, expires: value.expires ?? null });
    } catch {
      missing.push(label);
    }
  }
  return { accounts, missing };
}

// `-U` updates an existing item in place, so a failed write leaves the old
// token usable. The `security` binary that creates the item is the one the
// service later runs to read it, so no prompt is needed.
export function writeKeychainAccount(label: string, value: KeychainValue): void {
  const result = security([
    "add-generic-password",
    "-U",
    "-s",
    SERVICE,
    "-a",
    label,
    "-w",
    JSON.stringify(value),
    "-T",
    "/usr/bin/security",
  ]);
  if (result.status !== 0)
    throw new Error(`security add-generic-password failed for ${label}: ${result.stderr.trim()}`);
}

interface OpField {
  label?: string;
  value?: string;
}

// One label's token and expiry from 1Password.
function readOnePassword(label: string): KeychainValue {
  const result = spawnSync(
    "op",
    [
      "item",
      "get",
      itemTitle(label),
      "--vault",
      VAULT,
      "--fields",
      "label=token,label=expires",
      "--reveal",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `op item get failed for ${itemTitle(label)}`);
  const fields = JSON.parse(result.stdout) as OpField[];
  const field = (name: string) => fields.find((f) => f.label === name)?.value;
  const token = field("token");
  if (!token) throw new Error(`${itemTitle(label)} has no token field`);
  const expires = Date.parse(field("expires") ?? "");
  return { token, expires: Number.isFinite(expires) ? expires : null };
}

export interface SyncResult {
  synced: string[];
  failed: { label: string; error: string }[];
}

export function syncFromOnePassword(labels: readonly string[]): SyncResult {
  const result: SyncResult = { synced: [], failed: [] };
  for (const label of labels) {
    try {
      writeKeychainAccount(label, readOnePassword(label));
      result.synced.push(label);
    } catch (error) {
      result.failed.push({ label, error: (error as Error).message });
    }
  }
  return result;
}

// One-time import of OpenClaw's setup tokens into 1Password (M1). Read-only
// against OpenClaw; the account email is metadata read from each Claude
// config dir's .claude.json.
const OPENCLAW_DB = join(homedir(), ".openclaw", "state", "openclaw.sqlite");
const CONFIG_JSON: Record<string, string> = {
  personal: join(homedir(), ".claude.json"),
  personal_2: join(homedir(), ".claude_connorchevli", ".claude.json"),
  work: join(homedir(), ".claude_work", ".claude.json"),
};

interface OpenClawProfile {
  type?: string;
  provider?: string;
  token?: string;
  expires?: number;
}

function emailFor(label: string): string | null {
  const path = CONFIG_JSON[label];
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    return parsed.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export interface ImportPlan {
  label: string;
  email: string | null;
  expires: string | null;
}

export function importOpenClaw(
  labels: readonly string[],
  dryRun: boolean,
): { done: ImportPlan[]; failed: { label: string; error: string }[] } {
  const raw = spawnSync(
    "sqlite3",
    [
      "-readonly",
      OPENCLAW_DB,
      "select value_json from config_machine_state where state_key='authProfiles.store'",
    ],
    { encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`sqlite3 failed: ${raw.stderr.trim()}`);
  const store = JSON.parse(raw.stdout) as { profiles?: Record<string, OpenClawProfile> };
  const done: ImportPlan[] = [];
  const failed: { label: string; error: string }[] = [];
  for (const label of labels) {
    const profile = store.profiles?.[`anthropic:${label}`];
    if (!profile?.token) {
      failed.push({ label, error: `no anthropic:${label} token in OpenClaw` });
      continue;
    }
    const plan: ImportPlan = {
      label,
      email: emailFor(label),
      expires: profile.expires ? new Date(profile.expires).toISOString() : null,
    };
    if (dryRun) {
      done.push(plan);
      continue;
    }
    const item = {
      title: itemTitle(label),
      category: "API_CREDENTIAL",
      fields: [
        { id: "credential", type: "CONCEALED", label: "token", value: profile.token },
        { id: "expires", type: "STRING", label: "expires", value: plan.expires ?? "" },
        { id: "email", type: "STRING", label: "email", value: plan.email ?? "" },
      ],
    };
    const result = spawnSync("op", ["item", "create", "--vault", VAULT, "-"], {
      encoding: "utf8",
      input: JSON.stringify(item),
    });
    if (result.status !== 0)
      failed.push({ label, error: result.stderr.trim() || "op item create failed" });
    else done.push(plan);
  }
  return { done, failed };
}
