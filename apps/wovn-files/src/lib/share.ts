// The rules of a Share (ADR 0005), used by the host's PATCH validation and by
// the Banner's share form so both reject the same input.
import type { Share } from "./types";

// A Share lives in R2 customMetadata, which is capped at 2 KB per object.
export const MAX_SHARE_EMAILS = 20;

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
