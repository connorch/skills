// session-affinity-drain-soonest (D6): a session sticks to one account, new
// sessions all go to the account whose weekly bucket resets soonest, and a
// limit error moves the request to the next account in rank with no snap-back.
// Pure: the server builds Candidates from bucket state and applies the result.

import type { Candidate } from "./buckets.ts";

export interface Pin {
  label: string;
  lastSeen: number;
}

export interface Selection {
  // Accounts to try, in order. The first that does not fail over serves.
  order: string[];
  reason: string;
}

// Not demoted first, then the earliest future rankBucket reset (unknown
// last), then the lowest max utilization, then label for a stable order.
function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(a.demoted) - Number(b.demoted) ||
      (a.rankReset ?? Infinity) - (b.rankReset ?? Infinity) ||
      a.maxUtilization - b.maxUtilization ||
      a.label.localeCompare(b.label),
  );
}

export interface SelectInput {
  candidates: Candidate[];
  // The session's pin, if the request carries a session key.
  pin: Pin | undefined;
  // x-claude-router-account, already checked against the known labels.
  forced: string | null;
  pinIdleMs: number;
  now: number;
}

export function select({ candidates, pin, forced, pinIdleMs, now }: SelectInput): Selection {
  if (forced) return { order: [forced], reason: "forced" };

  const eligible = rank(candidates.filter((c) => c.eligible)).map((c) => c.label);
  if (eligible.length === 0) {
    // Nothing can serve. Ask the account that frees up soonest anyway, so the
    // client gets a real upstream error rather than a made-up one.
    const leastBad = [...candidates].sort(
      (a, b) =>
        (a.unavailableUntil ?? Infinity) - (b.unavailableUntil ?? Infinity) ||
        a.label.localeCompare(b.label),
    )[0];
    return { order: leastBad ? [leastBad.label] : [], reason: "no eligible account" };
  }

  if (pin && now - pin.lastSeen <= pinIdleMs) {
    if (eligible.includes(pin.label)) {
      return { order: [pin.label, ...eligible.filter((l) => l !== pin.label)], reason: "pinned" };
    }
    const why = candidates.find((c) => c.label === pin.label)?.why ?? "unknown";
    return { order: eligible, reason: `re-pin: ${pin.label} ${why}` };
  }
  return { order: eligible, reason: pin ? "pin expired" : "new session" };
}
