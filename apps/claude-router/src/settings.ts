// The only edit the router ever makes to ~/.claude/settings.json: add or
// remove env.ANTHROPIC_BASE_URL (D10). Formatting is preserved so `off`
// restores the file byte for byte apart from the removed key.

import { homedir } from "node:os";
import { join } from "node:path";

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };

function parse(text: string): Settings {
  const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json is not a JSON object");
  }
  return parsed as Settings;
}

function format(settings: Settings, like: string): string {
  const indent = /^( +)"/m.exec(like)?.[1]?.length ?? 2;
  const text = JSON.stringify(settings, null, indent);
  return like.endsWith("\n") || like === "" ? `${text}\n` : text;
}

export function currentBaseUrl(text: string): string | null {
  const value = parse(text).env?.[BASE_URL_KEY];
  return typeof value === "string" ? value : null;
}

// Refuses to replace a base URL that is not ours: `off` removes the key,
// so overwriting would lose a setting it cannot restore.
export function withRouter(text: string, baseUrl: string): string {
  const settings = parse(text);
  const existing = currentBaseUrl(text);
  if (existing !== null && existing !== baseUrl) {
    throw new Error(
      `settings.json already sets env.${BASE_URL_KEY} to ${existing}; remove it first if claude-router should replace it`,
    );
  }
  settings.env = { ...settings.env, [BASE_URL_KEY]: baseUrl };
  return format(settings, text);
}

export function withoutRouter(text: string): string {
  const settings = parse(text);
  if (!settings.env || !(BASE_URL_KEY in settings.env)) return text;
  const { [BASE_URL_KEY]: _removed, ...env } = settings.env;
  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  return format(settings, text);
}

// Line-level diff (longest common subsequence), enough for a one-key change.
export function diff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) lines.push(`- ${a[i++]}`);
    else lines.push(`+ ${b[j++]}`);
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (j < b.length) lines.push(`+ ${b[j++]}`);
  return lines;
}
