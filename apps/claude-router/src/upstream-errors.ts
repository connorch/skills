// What to do with an upstream response before any byte reaches the client
// (plan section 6). Classification reads status, headers, and, only for the
// statuses that need it, the JSON error type. Never message text.

import { allowed, headerValue, parseBuckets, type HeaderMap } from "./buckets.ts";

export type Mark =
  // Bucket headers already say which buckets are rejected; nothing extra.
  | "limit"
  // Token is dead until the next accounts sync.
  | "broken"
  // Org-level permission block: bench with backoff, probe one at a time.
  | "org_block"
  // 5xx or connection error after one retry, or a stream upstream cut
  // short: short bench.
  | "transient"
  // 429 with only a retry-after: bench for that long, capped.
  | "retry_after"
  // Request-scoped 429 (better-ccflare issue #301): try the next account,
  // hold nothing against this one.
  | null;

export type Verdict = { kind: "commit" } | { kind: "retry" } | { kind: "failover"; mark: Mark };

export interface UpstreamResult {
  status: number;
  headers: HeaderMap;
  // The body when it was read for classification; null otherwise.
  body: string | null;
  // Whether this account has already been retried once for this request.
  retried: boolean;
}

interface ErrorBody {
  error?: { type?: unknown; error_code?: unknown };
}

function errorBody(body: string | null): ErrorBody["error"] | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as ErrorBody).error;
      return error && typeof error === "object" ? error : undefined;
    }
  } catch {
    // Non-JSON error bodies classify on status alone.
  }
  return undefined;
}

export function classify({ status, headers, body, retried }: UpstreamResult): Verdict {
  if (status === 429) {
    // A rejected bucket blocks by itself. Bucket headers that reject nothing
    // (partial, or all allowed) say nothing, so fall through to retry-after.
    const rejected = Object.values(parseBuckets(headers, 0)).some((b) => !allowed(b.status));
    if (rejected) return { kind: "failover", mark: "limit" };
    if (headerValue(headers, "retry-after") !== undefined) {
      return { kind: "failover", mark: "retry_after" };
    }
    // Nothing to go on: request-scoped, hold nothing against the account.
    return { kind: "failover", mark: null };
  }
  if (status === 401) return { kind: "failover", mark: "broken" };
  if (status === 403) {
    const error = errorBody(body);
    const orgBlock =
      error?.type === "permission_error" &&
      (error.error_code === undefined || error.error_code === "oauth_not_allowed_for_organization");
    return orgBlock ? { kind: "failover", mark: "org_block" } : { kind: "commit" };
  }
  if (status >= 500 && status <= 599)
    return retried ? { kind: "failover", mark: "transient" } : { kind: "retry" };
  return { kind: "commit" };
}

// Seconds from a retry-after header, if it is a plain number.
export function retryAfterSeconds(headers: HeaderMap): number | null {
  const value = Number(headerValue(headers, "retry-after"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
