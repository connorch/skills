// Publish a page privately through the wovn CLI (skills/wovn-file-hosting)
// and return its URL. Pages for one Print Job share a Stable Path, so a
// re-publish replaces the page and wovn archives the previous Version.

import { execFileSync } from "node:child_process";

// One path segment from free text: lower-case letters, digits, and hyphens,
// so a job name can neither escape its folder nor break the URL.
export function slug(text: string, fallback = "page"): string {
  return (
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || fallback
  );
}
export function publish(file: string, key: string): string {
  const out = execFileSync("wovn", ["put", "--force", "--at", key, file], { encoding: "utf8" });
  const url = out.trim().split("\n").at(-1);
  if (!url?.startsWith("https://")) throw new Error(`wovn put did not return a URL:\n${out}`);
  return url;
}
