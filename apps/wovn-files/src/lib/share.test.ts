import { describe, expect, it } from "vite-plus/test";

import { isShareExpired, parseVisibilityPatch, shareSummary } from "./share";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const shared = (emails: unknown, expires?: unknown) => ({ visibility: "shared", emails, expires });

describe("parseVisibilityPatch", () => {
  it("passes public and private through and drops anything else", () => {
    expect(parseVisibilityPatch({ visibility: "public" }, NOW)).toEqual({ visibility: "public" });
    expect(parseVisibilityPatch({ visibility: "private", emails: ["a@b.co"] }, NOW)).toEqual({
      visibility: "private",
    });
  });

  it("normalizes the list: trimmed, lowercased, deduped", () => {
    expect(
      parseVisibilityPatch(shared([" Sam@Acme.com", "sam@acme.com ", "lee@acme.com"]), NOW),
    ).toEqual({
      visibility: "shared",
      emails: ["sam@acme.com", "lee@acme.com"],
      expires: null,
    });
  });

  it("normalizes the expiry to ISO and refuses the past", () => {
    const patch = parseVisibilityPatch(shared(["a@b.co"], "2026-10-13T00:00:00+02:00"), NOW);
    expect(patch).toMatchObject({ expires: "2026-10-12T22:00:00.000Z" });
    expect(parseVisibilityPatch(shared(["a@b.co"], "2026-10-06T11:59:59Z"), NOW)).toBe(
      "expires must be in the future",
    );
    expect(parseVisibilityPatch(shared(["a@b.co"], "soon"), NOW)).toBe(
      "expires must be an ISO timestamp or null",
    );
  });

  it("rejects malformed bodies and lists with a message", () => {
    expect(parseVisibilityPatch(null, NOW)).toMatch(/^body must be/);
    expect(parseVisibilityPatch({ visibility: "weird" }, NOW)).toMatch(/^body must be/);
    expect(parseVisibilityPatch(shared("a@b.co"), NOW)).toMatch(/^body must be/);
    expect(parseVisibilityPatch(shared([" "]), NOW)).toBe("a shared File needs at least one email");
    expect(parseVisibilityPatch(shared(["nope"]), NOW)).toBe("nope is not an email address");
    expect(
      parseVisibilityPatch(shared(Array.from({ length: 21 }, (_, i) => `u${i}@x.co`)), NOW),
    ).toBe("a File can be shared with at most 20 emails");
    const long = Array.from({ length: 20 }, (_, i) => `${"u".repeat(60)}${i}@x.co`);
    expect(parseVisibilityPatch(shared(long), NOW)).toBe(
      "the email list is too long (over 1024 bytes)",
    );
  });
});

describe("isShareExpired and shareSummary", () => {
  it("treats null as never and a past deadline as expired", () => {
    expect(isShareExpired({ emails: ["a@b.co"], expires: null }, NOW)).toBe(false);
    expect(isShareExpired({ emails: ["a@b.co"], expires: "2026-10-06T12:00:00Z" }, NOW)).toBe(true);
    expect(isShareExpired({ emails: ["a@b.co"], expires: "2026-10-06T12:00:01Z" }, NOW)).toBe(
      false,
    );
  });

  it("describes count, expiry, and the expired state", () => {
    expect(shareSummary({ emails: ["a@b.co"], expires: null })).toBe("1 email, never expires");
    expect(shareSummary({ emails: ["a@b.co", "c@d.co"], expires: "2999-01-01T00:00:00Z" })).toMatch(
      /^2 emails, expires /,
    );
    // formatWhen renders in local time, so only the shape is asserted.
    expect(shareSummary({ emails: ["a@b.co"], expires: "2000-01-01T12:00:00Z" })).toMatch(
      /^share expired (1999|2000)-/,
    );
  });
});
