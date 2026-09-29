import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { RequestLog, RouterState, type LogEntry } from "./state.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "claude-router-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RouterState", () => {
  it("round-trips through disk and drops what belonged to the old process", () => {
    const path = join(dir, "state.json");
    const state = new RouterState(path);
    state.account("a").bench = { until: 1, reason: "org_block", attempts: 1, probing: true };
    state.account("a").broken = { reason: "401", since: 1 };
    state.pins["k"] = { label: "a", lastSeen: 5 };
    state.save();
    const loaded = RouterState.load(path);
    expect(loaded.pins).toEqual({ k: { label: "a", lastSeen: 5 } });
    expect(loaded.account("a").broken).toBeNull();
    expect(loaded.account("a").bench).toMatchObject({
      reason: "org_block",
      attempts: 1,
      probing: false,
    });
  });

  it("starts empty from a corrupt file, keeps only well-shaped entries, and reports an unwritable path", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, "{not json");
    expect(RouterState.load(path).accounts).toEqual({});
    writeFileSync(path, "null");
    expect(RouterState.load(path).accounts).toEqual({});
    writeFileSync(
      path,
      JSON.stringify({
        accounts: { personal: null, work: { buckets: {}, modelBuckets: null } },
        pins: { k: 1 },
      }),
    );
    const loaded = RouterState.load(path);
    expect(Object.keys(loaded.accounts)).toEqual(["work"]);
    writeFileSync(
      path,
      JSON.stringify({
        accounts: {
          a: {
            buckets: {
              "5h": { status: "rejected", utilization: 1, resetAt: 1e300, seenAt: 1 },
              "7d": { status: "allowed", utilization: 0.1, resetAt: 5, seenAt: 1 },
            },
          },
        },
      }),
    );
    expect(Object.keys(RouterState.load(path).account("a").buckets)).toEqual(["7d"]);
    expect(loaded.account("work").modelBuckets).toEqual({});
    expect(loaded.pins).toEqual({});
    const blocked = new RouterState(join(path, "cannot", "nest", "under-a-file"));
    expect(() => blocked.save()).not.toThrow();
  });
});

describe("RequestLog", () => {
  const entry: LogEntry = {
    time: "t",
    kind: "routed",
    path: "/v1/messages",
    model: null,
    key: null,
    entrypoint: null,
    status: 200,
    reason: "r",
  };

  it("rotates once past the size cap", () => {
    const path = join(dir, "requests.jsonl");
    const log = new RequestLog(path, 200);
    for (let i = 0; i < 4; i++) log.append(entry);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBeLessThan(4);
  });
});
