// Bucket state per Account, learned only from anthropic-ratelimit-unified-*
// response headers (D3). Blocking is per bucket (D5): a model is blocked on
// an Account when any bucket seen on that model's responses is rejected
// until a future reset. Nothing here talks to the network.

export interface Bucket {
  status: string;
  utilization: number;
  // Epoch milliseconds.
  resetAt: number;
  seenAt: number;
}

export interface Bench {
  until: number;
  reason: "transient" | "org_block" | "retry_after";
  // org_block only: consecutive blocks (drives the backoff) and whether one
  // probe request is in flight after the bench expired.
  attempts: number;
  probing: boolean;
}

export interface AccountState {
  buckets: Record<string, Bucket>;
  // Bucket names seen on responses for each model: the block scope for it.
  modelBuckets: Record<string, string[]>;
  // A 401: the token is dead until the next `accounts sync`.
  broken: { reason: "401"; since: number } | null;
  bench: Bench | null;
}

export const emptyAccountState = (): AccountState => ({
  buckets: {},
  modelBuckets: {},
  broken: null,
  bench: null,
});

export type HeaderMap = Record<string, string | string[] | undefined>;

const BUCKET_HEADER = /^anthropic-ratelimit-unified-(.+)-(status|utilization|reset)$/;
// Same header shape as a bucket, but it describes pay-as-you-go overage.
const NOT_BUCKETS = new Set(["overage"]);
const FIELDS = ["status", "utilization", "reset"] as const;
type Field = (typeof FIELDS)[number];
const isField = (s: string): s is Field => (FIELDS as readonly string[]).includes(s);

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Every complete bucket in a response. Partial buckets (a status without a
// reset, say) are dropped rather than guessed at.
export function parseBuckets(headers: HeaderMap, now: number): Record<string, Bucket> {
  const partial: Record<string, Partial<Record<Field, string>>> = {};
  for (const [key, raw] of Object.entries(headers)) {
    const match = BUCKET_HEADER.exec(key.toLowerCase());
    const name = match?.[1];
    const field = match?.[2];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!name || !field || !isField(field) || NOT_BUCKETS.has(name) || value === undefined)
      continue;
    (partial[name] ??= {})[field] = value;
  }
  const buckets: Record<string, Bucket> = {};
  for (const [name, fields] of Object.entries(partial)) {
    const utilization = Number(fields.utilization);
    const reset = Number(fields.reset);
    if (!fields.status || !Number.isFinite(utilization) || !Number.isFinite(reset)) continue;
    buckets[name] = { status: fields.status, utilization, resetAt: reset * 1000, seenAt: now };
  }
  return buckets;
}

// Fold a response's headers into the account: the buckets it names replace
// the stored ones, and the set becomes the block scope for `model`.
export function recordResponse(
  state: AccountState,
  model: string | null,
  headers: HeaderMap,
  now: number,
): void {
  const parsed = parseBuckets(headers, now);
  const names = Object.keys(parsed);
  if (names.length === 0) return;
  Object.assign(state.buckets, parsed);
  if (model) state.modelBuckets[model] = names;
}

const allowed = (status: string) => status === "allowed" || status === "allowed_warning";

// Bucket names for a model this account has never served: the ones every
// known model shares (so a Fable-only rejection does not block Opus), or
// every bucket when nothing has been learned yet. Optimism is cheap here: a
// wrong guess costs one 429 round trip that failover hides from the client.
function sharedBuckets(state: AccountState): string[] {
  const sets = Object.values(state.modelBuckets);
  if (sets.length === 0) return Object.keys(state.buckets);
  return sets.reduce((shared, names) => shared.filter((n) => names.includes(n)));
}

// Buckets that still say something about `model`. A bucket whose reset has
// passed is unknown and is left out.
function applicable(state: AccountState, model: string | null, now: number): Bucket[] {
  const names = (model && state.modelBuckets[model]) || sharedBuckets(state);
  return names.flatMap((name) => {
    const bucket = state.buckets[name];
    return bucket && bucket.resetAt > now ? [bucket] : [];
  });
}

export interface Candidate {
  label: string;
  eligible: boolean;
  // Why it is not eligible, for status and the request log.
  why?: string;
  // When an ineligible account may serve again, if known. Orders the
  // "least bad" fallback when nothing is eligible.
  unavailableUntil: number | null;
  demoted: boolean;
  rankReset: number | null;
  maxUtilization: number;
}

export interface RankingConfig {
  rankBucket: string;
  demoteAt: number;
}

export function candidate(
  label: string,
  state: AccountState,
  model: string | null,
  config: RankingConfig,
  now: number,
): Candidate {
  const buckets = applicable(state, model, now);
  const rejected = buckets.filter((b) => !allowed(b.status));
  const blockedUntil = rejected.length > 0 ? Math.max(...rejected.map((b) => b.resetAt)) : null;
  const rank = state.buckets[config.rankBucket];
  const base = {
    label,
    demoted: buckets.some((b) => b.utilization >= config.demoteAt),
    rankReset: rank && rank.resetAt > now ? rank.resetAt : null,
    maxUtilization: Math.max(0, ...buckets.map((b) => b.utilization)),
  };
  if (state.broken) {
    return {
      ...base,
      eligible: false,
      why: `broken (${state.broken.reason})`,
      unavailableUntil: null,
    };
  }
  const bench = state.bench;
  if (bench && (now < bench.until || (bench.reason === "org_block" && bench.probing))) {
    const inFlight = bench.probing && now >= bench.until;
    // A probe in flight has no known end, so the least-bad fallback must
    // not pile concurrent requests onto it.
    return {
      ...base,
      eligible: false,
      why: `bench (${inFlight ? "org_block probe in flight" : bench.reason})`,
      unavailableUntil: inFlight ? null : bench.until,
    };
  }
  if (blockedUntil !== null) {
    return {
      ...base,
      eligible: false,
      why: `blocked until ${new Date(blockedUntil).toISOString()}`,
      unavailableUntil: blockedUntil,
    };
  }
  return { ...base, eligible: true, unavailableUntil: null };
}
