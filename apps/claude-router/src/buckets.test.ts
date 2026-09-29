import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { candidate, emptyAccountState, parseBuckets, recordResponse } from "./buckets.ts";

type Fixture = { status: number; headers: Record<string, string>; body: string | null };
export const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8"));

const config = { rankBucket: "7d", demoteAt: 0.95 };
// Fixtures were captured before their resets; any time before Oct 2026 works.
const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);

describe("parseBuckets", () => {
  it("reads every bucket and ignores overage and summary headers", () => {
    const buckets = parseBuckets(fixture("fable-429-7d_oi-rejected").headers, NOW);
    expect(Object.keys(buckets).sort()).toEqual(["5h", "7d", "7d_oi"]);
    expect(buckets["7d_oi"]).toMatchObject({
      status: "rejected",
      utilization: 1,
      resetAt: 1790877600 * 1000,
    });
    expect(buckets["5h"]).toMatchObject({ status: "allowed", utilization: 0.12 });
  });

  it("drops a bucket that is missing a field or has an impossible reset", () => {
    expect(parseBuckets({ "anthropic-ratelimit-unified-5h-status": "rejected" }, NOW)).toEqual({});
    const huge = {
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": "1e306",
    };
    expect(parseBuckets(huge, NOW)).toEqual({});
  });
});

describe("candidate", () => {
  it("blocks Fable on a 7d_oi rejection but leaves Sonnet alone on the same account", () => {
    const state = emptyAccountState();
    recordResponse(state, "claude-sonnet-5-5", fixture("sonnet-200").headers, NOW);
    recordResponse(state, "claude-fable-5-1", fixture("fable-429-7d_oi-rejected").headers, NOW);
    const fable = candidate("personal", state, "claude-fable-5-1", config, NOW);
    const sonnet = candidate("personal", state, "claude-sonnet-5-5", config, NOW);
    expect(fable.eligible).toBe(false);
    expect(fable.unavailableUntil).toBe(1790877600 * 1000);
    expect(sonnet).toMatchObject({
      eligible: true,
      rankReset: 1790877600 * 1000,
      maxUtilization: 0.57,
    });
  });

  it("judges an unseen model by the buckets every seen model shares", () => {
    const state = emptyAccountState();
    recordResponse(state, "claude-fable-5-1", fixture("fable-429-7d_oi-rejected").headers, NOW);
    // Only Fable seen: its rejected 7d_oi is all we know, so be careful.
    expect(candidate("personal", state, "claude-opus-5-5", config, NOW).eligible).toBe(false);
    // Sonnet seen without 7d_oi: the rejection is not universal, so Opus may try.
    recordResponse(state, "claude-sonnet-5-5", fixture("sonnet-200").headers, NOW);
    expect(candidate("personal", state, "claude-opus-5-5", config, NOW).eligible).toBe(true);
  });

  it("forgets a bucket once its reset has passed", () => {
    const state = emptyAccountState();
    recordResponse(state, "claude-fable-5-1", fixture("fable-429-7d_oi-rejected").headers, NOW);
    const later = 1790877600 * 1000 + 1;
    expect(candidate("personal", state, "claude-fable-5-1", config, later)).toMatchObject({
      eligible: true,
      rankReset: null,
    });
  });

  it("demotes at the utilization threshold and reports broken and benched accounts", () => {
    const state = emptyAccountState();
    recordResponse(
      state,
      "m",
      {
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.96",
        "anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 100),
      },
      NOW,
    );
    expect(candidate("a", state, "m", config, NOW)).toMatchObject({
      eligible: true,
      demoted: true,
    });
    state.bench = { until: NOW + 1000, reason: "transient", attempts: 0, probing: false };
    expect(candidate("a", state, "m", config, NOW)).toMatchObject({
      eligible: false,
      why: "bench (transient)",
    });
    expect(candidate("a", state, "m", config, NOW + 1001).eligible).toBe(true);
    // Benched for a second but bucket-blocked for longer: the later one counts.
    const blocked = emptyAccountState();
    recordResponse(blocked, "m", fixture("fable-429-7d_oi-rejected").headers, NOW);
    blocked.bench = { until: NOW + 1000, reason: "transient", attempts: 0, probing: false };
    expect(candidate("a", blocked, "m", config, NOW).unavailableUntil).toBe(1790877600 * 1000);
    state.broken = { reason: "401", since: NOW };
    expect(candidate("a", state, "m", config, NOW).why).toBe("broken (401)");
  });

  it("lets one probe through an expired org block and holds the rest", () => {
    const state = emptyAccountState();
    state.bench = { until: NOW - 1, reason: "org_block", attempts: 1, probing: false };
    expect(candidate("a", state, "m", config, NOW).eligible).toBe(true);
    state.bench.probing = true;
    expect(candidate("a", state, "m", config, NOW)).toMatchObject({
      why: "bench (org_block probe in flight)",
      unavailableUntil: null,
    });
  });
});
