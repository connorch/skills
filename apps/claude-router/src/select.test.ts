import { describe, expect, it } from "vite-plus/test";
import type { Candidate } from "./buckets.ts";
import { select } from "./select.ts";

const NOW = 1_000_000;
const cand = (label: string, extra: Partial<Candidate> = {}): Candidate => ({
  label,
  eligible: true,
  unavailableUntil: null,
  demoted: false,
  rankReset: null,
  maxUtilization: 0,
  ...extra,
});
const pick = (
  candidates: Candidate[],
  pin?: { label: string; lastSeen: number },
  forced: string | null = null,
) => select({ candidates, pin, forced, pinIdleMs: 3_600_000, now: NOW });

describe("select", () => {
  it("ranks by soonest weekly reset, unknown last, demoted after everything", () => {
    const { order, reason } = pick([
      cand("late", { rankReset: NOW + 5000 }),
      cand("unknown"),
      cand("soon", { rankReset: NOW + 1000 }),
      cand("demoted", { rankReset: NOW + 10, demoted: true }),
    ]);
    expect(order).toEqual(["soon", "late", "unknown", "demoted"]);
    expect(reason).toBe("new session");
  });

  it("keeps a live pin first and puts the rest behind it in rank", () => {
    const candidates = [
      cand("a", { rankReset: NOW + 1 }),
      cand("b", { rankReset: NOW + 2 }),
      cand("c"),
    ];
    expect(pick(candidates, { label: "c", lastSeen: NOW - 60_000 })).toEqual({
      order: ["c", "a", "b"],
      reason: "pinned",
    });
  });

  it("re-pins when the pinned account is not eligible and never snaps back", () => {
    const candidates = [
      cand("a", { eligible: false, why: "blocked until X", unavailableUntil: NOW + 9 }),
      cand("b"),
    ];
    expect(pick(candidates, { label: "a", lastSeen: NOW })).toEqual({
      order: ["b"],
      reason: "re-pin: a blocked until X",
    });
  });

  it("treats an idle pin as expired", () => {
    const candidates = [cand("a"), cand("b")];
    expect(pick(candidates, { label: "b", lastSeen: NOW - 3_600_001 }).reason).toBe("pin expired");
  });

  it("forces one account with no failover order", () => {
    expect(pick([cand("a"), cand("b", { eligible: false })], undefined, "b")).toEqual({
      order: ["b"],
      reason: "forced",
    });
  });

  it("falls back to the account that frees up soonest when nothing is eligible", () => {
    const candidates = [
      cand("a", { eligible: false, unavailableUntil: NOW + 500 }),
      cand("b", { eligible: false, unavailableUntil: NOW + 100 }),
      cand("c", { eligible: false, unavailableUntil: null }),
    ];
    expect(pick(candidates)).toEqual({ order: ["b"], reason: "no eligible account" });
  });
});
