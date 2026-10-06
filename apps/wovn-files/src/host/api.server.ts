// The /api machine surface (docs/adr/0002), REST over files.server.ts.
// Anonymous requests get a plain 401, never the login redirect: /api is a
// Reserved Key whose existence is not secret, and a 302 to an HTML login
// page confuses API clients.
//   GET /api/files                - the collection; ?prefix=&delimiter=/ is
//     one directory level (browse), project/branch/worktree/dir/type/
//     visibility/limit compose as filters (list), newest first when not
//     browsing.
//   GET|PATCH|DELETE /api/files/<key> - metadata; {"visibility": ...} flips
//     the stamp (with "emails" and "expires" for "shared", ADR 0005); DELETE
//     removes the File and all its Versions.
//   GET /api/versions/<key>       - the File's Versions, newest first.
import { isEmail, MAX_SHARE_EMAILS, normalizeEmails } from "@/lib/share";
import type { VisibilityPatch } from "@/lib/types";
import { isAuthenticated } from "./auth.server";
import {
  deleteFile,
  fileMeta,
  isArchiveKey,
  listFiles,
  setVisibility,
  versionsOf,
} from "./files.server";

const NO_STORE = { "cache-control": "no-store" };

export async function api(request: Request, url: URL): Promise<Response> {
  if (!(await isAuthenticated(request))) return new Response("unauthorized\n", { status: 401 });
  const path = decodeURIComponent(url.pathname);

  if (path === "/api/files" || path === "/api/files/") {
    if (request.method !== "GET") return new Response("method not allowed\n", { status: 405 });
    return Response.json(await listFiles(url.searchParams), {
      headers: NO_STORE,
    });
  }
  if (path.startsWith("/api/files/")) {
    const key = path.slice("/api/files/".length).replace(/\/+$/, "");
    if (request.method === "GET") return metaResponse(key);
    if (request.method === "PATCH") return patch(request, key);
    if (request.method === "DELETE") {
      const deleted = await deleteFile(key);
      if (deleted.length === 0) return new Response("not found\n", { status: 404 });
      return Response.json({ deleted }, { headers: NO_STORE });
    }
    return new Response("method not allowed\n", { status: 405 });
  }
  if (path.startsWith("/api/versions/")) {
    if (request.method !== "GET") return new Response("method not allowed\n", { status: 405 });
    const key = path.slice("/api/versions/".length).replace(/\/+$/, "");
    return Response.json(await versionsOf(key), { headers: NO_STORE });
  }
  return new Response("not found\n", { status: 404 });
}

async function metaResponse(key: string): Promise<Response> {
  const meta = await fileMeta(key);
  if (!meta) return new Response("not found\n", { status: 404 });
  return Response.json(meta, { headers: NO_STORE });
}

async function patch(request: Request, key: string): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = parsePatch(body);
  if (typeof parsed === "string") return new Response(`${parsed}\n`, { status: 400 });
  if (isArchiveKey(key)) return new Response("Versions are always private\n", { status: 400 });
  const meta = await setVisibility(key, parsed);
  if (!meta) return new Response("not found\n", { status: 404 });
  return Response.json(meta, { headers: NO_STORE });
}

// The PATCH body as a VisibilityPatch, or the message for a 400.
function parsePatch(body: unknown): VisibilityPatch | string {
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
  const invalid = list.find((email) => !isEmail(email));
  if (invalid) return `${invalid} is not an email address`;

  if (expires === null || expires === undefined) return { visibility, emails: list, expires: null };
  if (typeof expires !== "string" || Number.isNaN(Date.parse(expires))) {
    return "expires must be an ISO timestamp or null";
  }
  if (Date.parse(expires) <= Date.now()) return "expires must be in the future";
  return { visibility, emails: list, expires: new Date(expires).toISOString() };
}
