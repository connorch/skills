// On-disk state (bucket state, learned model buckets, pins) and the request
// log. Both are optional so tests can run in memory.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { emptyAccountState, type AccountState } from "./buckets.ts";
import type { Pin } from "./select.ts";

interface Persisted {
  accounts: Record<string, AccountState>;
  pins: Record<string, Pin>;
}

export class RouterState {
  accounts: Record<string, AccountState> = {};
  pins: Record<string, Pin> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string | null) {}

  static load(path: string | null): RouterState {
    const state = new RouterState(path);
    if (path && existsSync(path)) {
      // Best effort, like save(): a corrupt file must not crash-loop the service.
      let raw: Partial<Persisted> = {};
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object") raw = parsed as Partial<Persisted>;
      } catch (error) {
        console.error(`state: ${(error as Error).message}; starting empty`);
      }
      // Only entries with the expected shape survive; a probe belongs to
      // the process that started it.
      const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
      for (const [label, account] of Object.entries(raw.accounts ?? {})) {
        const a = record(account) as Partial<AccountState> | null;
        if (!a) continue;
        const st = emptyAccountState();
        if (record(a.buckets)) st.buckets = a.buckets as AccountState["buckets"];
        for (const [model, names] of Object.entries(record(a.modelBuckets) ?? {})) {
          if (Array.isArray(names) && names.every((n) => typeof n === "string")) {
            st.modelBuckets[model] = names;
          }
        }
        if (record(a.broken)) st.broken = a.broken as AccountState["broken"];
        if (record(a.bench))
          st.bench = { ...(a.bench as NonNullable<AccountState["bench"]>), probing: false };
        state.accounts[label] = st;
      }
      for (const [key, pin] of Object.entries(raw.pins ?? {})) {
        if (pin && typeof pin.label === "string" && typeof pin.lastSeen === "number")
          state.pins[key] = pin;
      }
    }
    return state;
  }

  // Own properties only: a label like "constructor" must not read the prototype.
  account(label: string): AccountState {
    if (!Object.hasOwn(this.accounts, label)) this.accounts[label] = emptyAccountState();
    return this.accounts[label] as AccountState;
  }

  // Coalesce writes: a burst of requests changes state many times a second.
  touch(): void {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 500);
    this.timer.unref();
  }

  // Best effort: routing works without persistence, so a full disk must
  // not take the service down.
  save(): boolean {
    if (!this.path) return true;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const data: Persisted = { accounts: this.accounts, pins: this.pins };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.path);
      return true;
    } catch (error) {
      console.error(`state: ${(error as Error).message}`);
      return false;
    }
  }

  prunePins(now: number, idleMs: number): void {
    for (const [key, pin] of Object.entries(this.pins)) {
      if (now - pin.lastSeen > idleMs) delete this.pins[key];
    }
  }
}

export interface LogEntry {
  time: string;
  kind: "routed" | "passthrough" | "router_error";
  path: string;
  model: string | null;
  // sha256 prefix of metadata.user_id, never the id itself.
  key: string | null;
  entrypoint: string | null;
  account?: string;
  status: number;
  // Accounts tried, in order, including the one that served.
  attempts?: string[];
  reason: string;
  forced?: boolean;
}

// One JSON line per request. Rotates once to `<path>.1` past `maxBytes`.
export class RequestLog {
  private bytes = 0;
  readonly entries: LogEntry[] = [];

  constructor(
    private readonly path: string | null,
    private readonly maxBytes = 50 * 1024 * 1024,
  ) {
    if (path && existsSync(path)) this.bytes = statSync(path).size;
  }

  append(entry: LogEntry): void {
    if (!this.path) {
      this.entries.push(entry);
      return;
    }
    try {
      this.write(this.path, entry);
    } catch (error) {
      console.error(`request log: ${(error as Error).message}`);
    }
  }

  private write(path: string, entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    if (this.bytes + line.length > this.maxBytes) {
      renameSync(path, `${path}.1`);
      this.bytes = 0;
    }
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    this.bytes += line.length;
  }
}
