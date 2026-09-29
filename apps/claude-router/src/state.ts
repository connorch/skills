// On-disk state (per-account state and pins) and the request log. Both are
// optional so tests can run in memory.

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
import { z } from "zod";
import { emptyAccountState, MAX_DATE_MS, type AccountState } from "./buckets.ts";
import type { Pin } from "./select.ts";

interface Persisted {
  accounts: Record<string, AccountState>;
  pins: Record<string, Pin>;
}

// What load() accepts from disk. Anything malformed is dropped at the level
// it appears: one bad bucket loses that bucket, one bad account loses that
// account, a bad file starts empty. A probe belongs to the process that
// started it, so it never survives a load.
const finite = z.number().finite();
const ms = finite.min(-MAX_DATE_MS).max(MAX_DATE_MS);
const Bucket = z.object({
  status: z.string(),
  utilization: finite,
  resetAt: ms,
  seenAt: ms,
});
const Account = z.object({
  buckets: z.record(z.string(), Bucket.catch(undefined as never)).catch({}),
  modelBuckets: z.record(z.string(), z.array(z.string())).catch({}),
  broken: z
    .object({ reason: z.literal("401"), since: ms })
    .nullable()
    .catch(null),
  bench: z
    .object({
      until: ms,
      reason: z.enum(["transient", "org_block", "retry_after"]),
      attempts: finite,
      probing: z.boolean(),
    })
    .transform((bench) => ({ ...bench, probing: false }))
    .nullable()
    .catch(null),
});
const PersistedFile = z.object({
  accounts: z.record(z.string(), Account.catch(undefined as never)).catch({}),
  pins: z
    .record(z.string(), z.object({ label: z.string(), lastSeen: ms }).catch(undefined as never))
    .catch({}),
});

// Entries a `.catch(undefined)` dropped leave holes; strip them.
function compact<T>(record: Record<string, T | undefined>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter((e): e is [string, T] => e[1] !== undefined),
  );
}

export class RouterState {
  accounts: Record<string, AccountState> = {};
  pins: Record<string, Pin> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string | null) {}

  static load(path: string | null): RouterState {
    const state = new RouterState(path);
    if (!path || !existsSync(path)) return state;
    // Best effort, like save(): a corrupt file must not crash-loop the service.
    try {
      const file = PersistedFile.parse(JSON.parse(readFileSync(path, "utf8")));
      for (const [label, account] of Object.entries(compact(file.accounts))) {
        state.accounts[label] = { ...account, buckets: compact(account.buckets) };
      }
      state.pins = compact(file.pins);
    } catch (error) {
      console.error(`state: ${(error as Error).message}; starting empty`);
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
