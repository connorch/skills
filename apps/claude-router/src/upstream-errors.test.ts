import { describe, expect, it } from "vite-plus/test";
import { classify, retryAfterSeconds } from "./upstream-errors.ts";

const verdict = (
  status: number,
  headers: Record<string, string> = {},
  body: string | null = null,
  retried = false,
) => classify({ status, headers, body, retried });

describe("classify", () => {
  it("fails over on a limit 429 and on a bare request-scoped 429", () => {
    const rejected = {
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-reset": "1790644200",
    };
    expect(verdict(429, rejected)).toEqual({
      kind: "failover",
      mark: "limit",
    });
    expect(verdict(429, { "x-should-retry": "true" })).toEqual({ kind: "failover", mark: null });
    expect(verdict(429, { "retry-after": "30" })).toEqual({
      kind: "failover",
      mark: "retry_after",
    });
    expect(verdict(429)).toEqual({ kind: "failover", mark: null });
    // Bucket headers that reject nothing do not count as a limit.
    expect(
      verdict(429, { "anthropic-ratelimit-unified-5h-status": "allowed", "retry-after": "30" }),
    ).toEqual({ kind: "failover", mark: "retry_after" });
  });

  it("marks a 401 broken", () => {
    expect(verdict(401)).toEqual({ kind: "failover", mark: "broken" });
  });

  it("only treats the org permission block as a 403 worth failing over", () => {
    const block = JSON.stringify({
      type: "error",
      error: { type: "permission_error", message: "x" },
    });
    const orgCode = JSON.stringify({
      error: { type: "permission_error", error_code: "oauth_not_allowed_for_organization" },
    });
    const other = JSON.stringify({
      error: { type: "permission_error", error_code: "something_else" },
    });
    expect(verdict(403, {}, block)).toEqual({ kind: "failover", mark: "org_block" });
    expect(verdict(403, {}, orgCode)).toEqual({ kind: "failover", mark: "org_block" });
    expect(verdict(403, {}, other)).toEqual({ kind: "commit" });
    expect(verdict(403, {}, "<html>forbidden</html>")).toEqual({ kind: "commit" });
  });

  it("retries a 5xx once on the same account, then benches and fails over", () => {
    expect(verdict(529)).toEqual({ kind: "retry" });
    expect(verdict(503, {}, null, true)).toEqual({ kind: "failover", mark: "transient" });
  });

  it("commits everything else, including client errors", () => {
    expect(verdict(200)).toEqual({ kind: "commit" });
    expect(verdict(400)).toEqual({ kind: "commit" });
    expect(verdict(404)).toEqual({ kind: "commit" });
  });

  it("reads Retry-After as seconds, zero included, and ignores dates", () => {
    expect(retryAfterSeconds({ "retry-after": "0" })).toBe(0);
    expect(retryAfterSeconds({ "retry-after": "30" })).toBe(30);
    expect(retryAfterSeconds({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeNull();
    expect(retryAfterSeconds({})).toBeNull();
  });
});
