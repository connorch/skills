// The rules of a Share (ADR 0005): what the host's PATCH accepts, what the
// Banner's share form rejects before sending, and how a Share is described,
// so every surface agrees.
import { formatWhen } from "./format";
import type { Share, VisibilityPatch } from "./types";

// A Share lives in R2 customMetadata, which is capped at 2 KB per object
// including the File's git context, so both the count and the serialized
// length of the list are bounded.
export const MAX_SHARE_EMAILS = 20;
export const MAX_SHARE_BYTES = 1024;

// Shape only: a Guest proves the address itself at the Guest Login.
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

// Trimmed, lowercased, deduped, empties dropped - the form the host stores.
export function normalizeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export function isShareExpired(share: Share, now = Date.now()): boolean {
  return share.expires !== null && Date.parse(share.expires) <= now;
}

// "2 emails, expires Oct 13" / "2 emails, never expires" / "share expired
// Oct 3": the Share as the Finder's fact row and the toast describe it.
export function shareSummary(share: Share): string {
  const count = `${share.emails.length} email${share.emails.length === 1 ? "" : "s"}`;
  if (share.expires === null) return `${count}, never expires`;
  if (isShareExpired(share)) return `share expired ${formatWhen(share.expires)}`;
  return `${count}, expires ${formatWhen(share.expires)}`;
}

// A PATCH /api/files/<key> body as a VisibilityPatch, or the message for a
// 400. Emails are normalized here, so the stored list is what the host read
// back; `now` is a parameter so the rule is testable.
export function parseVisibilityPatch(body: unknown, now = Date.now()): VisibilityPatch | string {
  const usage =
    'body must be {"visibility": "public" | "private"} or {"visibility": "shared", "emails": [...], "expires": "<iso>" | null}';
  if (typeof body !== "object" || body === null) return usage;
  const { visibility, emails, expires } = body as Record<string, unknown>;
  if (visibility === "public" || visibility === "private") return { visibility };
  if (visibility !== "shared") return usage;

  if (!Array.isArray(emails) || !emails.every((email) => typeof email === "string")) return usage;
  const list = normalizeEmails(emails);
  if (list.length === 0) return "a shared File needs at least one email";
  if (list.length > MAX_SHARE_EMAILS)
    return `a File can be shared with at most ${MAX_SHARE_EMAILS} emails`;
  if (new TextEncoder().encode(list.join(",")).byteLength > MAX_SHARE_BYTES) {
    return `the email list is too long (over ${MAX_SHARE_BYTES} bytes)`;
  }
  const invalid = list.find((email) => !isEmail(email));
  if (invalid) return `${invalid} is not an email address`;

  if (expires === null || expires === undefined) return { visibility, emails: list, expires: null };
  if (typeof expires !== "string" || Number.isNaN(Date.parse(expires))) {
    return "expires must be an ISO timestamp or null";
  }
  if (Date.parse(expires) <= now) return "expires must be in the future";
  return { visibility, emails: list, expires: new Date(expires).toISOString() };
}
