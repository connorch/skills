// File host for files.wovn.org, used by the wovn-file-hosting skill. One
// hostname, one R2 bucket; every File carries its Visibility in
// customMetadata and is private unless explicitly stamped
// `visibility: public` (fail closed). Objects under archive/ - Versions of
// Stable Paths - are always private regardless of stamping.
//
// Auth: two interchangeable credentials, checked by isAuthenticated().
//  - The WOVN_TOKEN bearer token (the wovn CLI and curl fallback).
//  - A Cloudflare Access JWT in a cookie, minted by the /login flow: the
//    Access application is path-scoped to files.wovn.org/login only, so the
//    Access edge intercepts just that path, runs the interactive login, and
//    injects `cf-access-jwt-assertion`; the /login handler copies that JWT
//    into a host-wide cookie and redirects back. Every other route verifies
//    the cookie itself (signature, issuer, audience, expiry), so a deleted or
//    misconfigured Access app fails closed. See docs/adr/0001.
//
// URL resolution (docs/adr/0002): an exact Key match serves the File; any
// other GET path is a Directory Route. A public File is served to anyone;
// everything else - private File, Directory Route, or nothing at all - 302s
// anonymous requests to /login identically, so probing leaks nothing.
// Authenticated Directory Routes serve the browse-UI SPA shell (the ui/ app,
// bundled under the reserved /_/ prefix via the ASSETS binding) when the
// request accepts text/html; non-HTML clients keep a plain 404 so scripted
// reads detect errors. A trailing slash always means a Directory Route.
// /<key>/archive/<stamp> is an alias serving the archive/<key>/<stamp>
// Version (/<key>/archive itself has no Key, so it falls to the SPA, which
// renders the File's history).
//
// PUT/POST upload (authenticated); the response body is the permanent URL.
// POST mints a collision-proof immutable Generated Key
// (yyyy/mm/<random>-<filename>); PUT writes the exact request path (a Stable
// Path) and refuses to overwrite an existing File unless the client forces
// it. A forced overwrite first copies the old state to
// archive/<path>/<stamp>, so Stable Paths keep their full history, and
// preserves the old File's Visibility unless the request explicitly restates
// it - updating a published document does not unpublish it. Reserved Keys
// are rejected with a message naming the reserved word. Uploads carry the
// client's git context in x-wovn-* headers (see META_HEADERS), stored as
// customMetadata.
//
// Management is REST under /api (anonymous requests get a plain 401, never
// the login redirect):
//   GET /api/files                - the collection; ?prefix=&delimiter=/ is
//     one directory level (browse), project/branch/worktree/dir/type/
//     visibility/limit compose as filters (list), newest first when not
//     browsing.
//   GET|PATCH|DELETE /api/files/<key> - metadata; {"visibility": ...} flips
//     the stamp; DELETE removes the File and all its Versions.
//   GET /api/versions/<key>       - the File's Versions, newest first.

// Top-level Key segments uploads may never claim: live system routes plus
// deliberately over-reserved future surfaces (docs/adr/0002) - permanent URLs
// make later collisions expensive, reserving costs nothing.
const RESERVED_TOP_LEVEL = [
  "login",
  "_", // the browse-UI asset bundle
  "favicon.ico",
  "robots.txt",
  ".well-known",
  "api",
  "app",
  "assets",
  "static",
  "auth",
  "logout",
  "admin",
  "settings",
  "upload",
  "search",
  "share",
  "status",
  "health",
];

// The reserved word an upload key violates, or null. `archive` is a Reserved
// Key in EVERY segment (not just top-level) so the /<key>/archive alias
// routes can never be shadowed by a real File.
function reservedWordIn(key: string): string | null {
  const segments = key.split("/");
  if (segments.includes("archive")) return "archive";
  return RESERVED_TOP_LEVEL.includes(segments[0]) ? segments[0] : null;
}

const AUTH_COOKIE = "wovn_auth";
// Query marker appended by the /login redirect; if a request arrives with it
// and still has no valid cookie, the client refuses cookies - fail with 403
// instead of redirecting forever.
const LOGIN_MARKER = "wovn-authed";

// Fallback for uploads that arrive without a useful Content-Type (curl -T
// sends application/octet-stream), so browsers render images inline.
const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

// Coarse file-type buckets for the `type` filter, matched against the
// extension in the Key. Categories are deliberately non-overlapping so
// combining them stays easy to reason about; anything not covered here is
// still filterable by passing the bare extension.
const TYPE_CATEGORIES: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
  video: ["mp4", "webm", "mov"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "md", "html", "txt", "log"],
  data: ["json", "csv", "yaml", "yml"],
  archive: ["zip", "tar", "gz", "tgz"],
};

// The lowercased extension of a key's final segment, or "" when it has none.
function extensionOf(key: string): string {
  const name = key.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// Git context the wovn CLI infers at upload time and sends as headers;
// stored as customMetadata so /api/files can filter by it.
const META_HEADERS = {
  "x-wovn-dir": "dir",
  "x-wovn-branch": "branch",
  "x-wovn-worktree": "worktree",
  "x-wovn-project": "project",
  "x-wovn-project-path": "projectPath",
} as const;

function contentTypeFor(filename: string, headerValue: string | null): string {
  if (headerValue && headerValue !== "application/octet-stream") return headerValue;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function isArchiveKey(key: string): boolean {
  return key === "archive" || key.startsWith("archive/");
}

// The single fail-closed Visibility rule: public only when explicitly
// stamped, and never under archive/.
function isPublic(key: string, meta: Record<string, string> | undefined): boolean {
  return !isArchiveKey(key) && meta?.visibility === "public";
}

function visibilityOf(key: string, meta: Record<string, string> | undefined): "public" | "private" {
  return isPublic(key, meta) ? "public" : "private";
}

function isTokenAuthorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(token);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// A request is authenticated with either the bearer token or a valid Access
// JWT cookie - our own relay cookie, or the CF_Authorization cookie Access
// itself sets on this hostname during the /login flow. Both credentials are
// equivalent everywhere; there are no per-route auth rules.
async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (isTokenAuthorized(request, env.WOVN_TOKEN)) return true;
  for (const name of [AUTH_COOKIE, "CF_Authorization"]) {
    const jwt = cookieValue(request, name);
    if (jwt && (await verifyJwt(jwt, env)) !== null) return true;
  }
  return false;
}

// The uniform response for anonymous requests to anything non-public: private
// File, Directory Route, or nothing at all - identical, so probing leaks
// nothing about which Keys exist.
function loginRedirect(url: URL): Response {
  // Arriving with the marker means we just came back from /login and the
  // cookie still is not there: the client refuses cookies, so redirecting
  // again would loop.
  if (url.searchParams.has(LOGIN_MARKER)) {
    return new Response("authentication requires cookies\n", { status: 403 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `/login?to=${encodeURIComponent(url.pathname)}`,
      "cache-control": "no-store",
    },
  });
}

// Stable Paths (PUT) use the request path verbatim, sanitized per segment.
function stableKey(pathname: string): string | null {
  const key = decodeURIComponent(pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "-"))
    .join("/");
  return key || null;
}

function randomSlug(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function objectKey(pathname: string): string {
  const filename =
    decodeURIComponent(pathname)
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "-") || "file";
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${randomSlug()}-${filename}`;
}

// Versions live under archive/<stable-path>/; the key structure is the whole
// history index (no metadata bookkeeping to drift out of sync), and the
// timestamp prefix makes lexicographic order chronological.
function archiveKeyFor(key: string): string {
  const stamp = new Date().toISOString().toLowerCase().replace(/[:.]/g, "-");
  return `archive/${key}/${stamp}-${randomSlug()}`;
}

// Cloudflare Access JWT verification. The signing keys are public and rotate
// rarely; caching them module-level is config, not request state.
let certsCache: { keys: (JsonWebKey & { kid?: string })[]; expires: number } | undefined;

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function accessSigningKeys(teamDomain: string) {
  if (certsCache && certsCache.expires > Date.now()) return certsCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = await res.json<{ keys: (JsonWebKey & { kid?: string })[] }>();
  certsCache = { keys, expires: Date.now() + 3600_000 };
  return keys;
}

// Full verification of an Access JWT: issuer, audience, expiry, signature.
// Returns the expiry (for cookie Max-Age) on success, null on any failure.
async function verifyJwt(jwt: string, env: Env): Promise<{ exp: number } | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(b64urlDecode(parts[0]))) as { kid?: string };
    const payload = JSON.parse(decoder.decode(b64urlDecode(parts[1]))) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
    };
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;

    const jwk = (await accessSigningKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { exp: payload.exp } : null;
  } catch {
    return null;
  }
}

// /login: the only Access-gated path. The Access edge has already forced the
// interactive login and injected the JWT; relay it into a host-wide cookie
// and bounce back to the requested path. Without the Access app in front,
// there is no JWT and this fails closed.
async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("login is not gated by a Cloudflare Access application; refusing\n", {
      status: 503,
    });
  }
  const payload = await verifyJwt(jwt, env);
  if (!payload) return new Response("forbidden\n", { status: 403 });

  // `to` must be a same-origin absolute path ("/x", not "//host" or a URL).
  const to = url.searchParams.get("to") ?? "/";
  const dest = /^\/(?!\/)/.test(to) ? to : "/";
  const maxAge = Math.max(0, Math.floor(payload.exp - Date.now() / 1000));
  const separator = dest.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${dest}${separator}${LOGIN_MARKER}=1`,
      "set-cookie": `${AUTH_COOKIE}=${jwt}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      "cache-control": "no-store",
    },
  });
}

async function upload(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  if (!request.body) return new Response("missing request body\n", { status: 400 });

  const customMetadata: Record<string, string> = {};
  for (const [header, name] of Object.entries(META_HEADERS)) {
    const value = request.headers.get(header);
    if (value) customMetadata[name] = value;
  }
  // Fail closed: public only on an explicit request. An absent or unknown
  // header value means private (no stamp at all).
  const requestedVisibility = request.headers.get("x-wovn-visibility");
  if (requestedVisibility === "public") customMetadata.visibility = "public";

  // POST mints an immutable dated key; PUT stores at the exact requested
  // path, so the URL stays stable across re-uploads.
  let key: string;
  if (request.method === "PUT") {
    const stable = stableKey(url.pathname);
    if (!stable) return new Response("PUT needs an explicit path\n", { status: 400 });
    const reserved = reservedWordIn(stable);
    if (reserved) {
      return new Response(`${reserved} is a reserved name; pick a different path\n`, {
        status: 400,
      });
    }
    key = stable;
    customMetadata.stable = "true";
    // Overwrites are opt-in (the CLI's --force sets the header). Enforced
    // here, not just in the CLI, so no client can clobber a path by accident.
    if (request.headers.get("x-wovn-force") !== "1") {
      if ((await bucket.head(key)) !== null) {
        return new Response(`${key} already exists; pass --force to replace it\n`, { status: 409 });
      }
    } else {
      // A forced overwrite archives the Version it replaces, keeping its
      // content type and git context. `uploaded` preserves when that Version
      // was originally written (the copy's own timestamp is the archive
      // time); `stable` and `visibility` are dropped - Versions are
      // immutable and always private.
      const existing = await bucket.get(key);
      if (existing) {
        const meta = { ...existing.customMetadata };
        delete meta.stable;
        delete meta.visibility;
        meta.uploaded = existing.uploaded.toISOString();
        await bucket.put(archiveKeyFor(key), existing.body, {
          httpMetadata: existing.httpMetadata,
          customMetadata: meta,
        });
        // Visibility is an attribute of the path, not of one upload: updating
        // a published document must not silently unpublish it. The request
        // can still restate it explicitly ("public" or "private") to flip.
        if (requestedVisibility !== "public" && requestedVisibility !== "private") {
          if (existing.customMetadata?.visibility === "public") customMetadata.visibility = "public";
        }
      }
    }
  } else {
    key = objectKey(url.pathname);
  }

  const contentType = contentTypeFor(key, request.headers.get("content-type"));
  await bucket.put(key, request.body, { httpMetadata: { contentType }, customMetadata });
  return new Response(`https://${url.hostname}/${key}\n`, { status: 201 });
}

interface FileEntry {
  key: string;
  size: number;
  uploaded: string;
  visibility: "public" | "private";
  stable: boolean;
  project?: string;
  branch?: string;
}

function fileEntryOf(object: R2Object): FileEntry {
  const meta = object.customMetadata;
  return {
    key: object.key,
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    visibility: visibilityOf(object.key, meta),
    stable: meta?.stable === "true",
    ...(meta?.project && { project: meta.project }),
    ...(meta?.branch && { branch: meta.branch }),
  };
}

// GET /api/files - the collection. `prefix` + `delimiter` browse one
// directory level; project/branch/worktree/dir (git context), type
// (extension), and visibility filter; `limit` caps the result. Filters
// compose. Browse results sort by name, everything else newest first.
async function listFiles(url: URL, bucket: R2Bucket): Promise<Response> {
  const params = url.searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit")) || 20, 1), 1000);
  const prefix = params.get("prefix") ?? "";
  const delimiter = params.get("delimiter") ?? undefined;

  // Git-context filters (see META_HEADERS). Every provided filter must match;
  // Files uploaded without context (pre-tagging, or curl) never match.
  // "project" matches the project name or its full path, so both
  // `--project skills` and an inferred absolute path work.
  const filters = (["project", "branch", "worktree", "dir"] as const).flatMap((name) => {
    const value = params.get(name);
    return value === null ? [] : [{ name, value }];
  });
  const matches = (meta: Record<string, string> | undefined) =>
    filters.every(({ name, value }) =>
      name === "project"
        ? meta?.project === value || meta?.projectPath === value
        : meta?.[name] === value,
    );

  // File-type filter: comma-separated categories (see TYPE_CATEGORIES) and/or
  // bare extensions, OR'd together. Applied before the limit slice, so
  // `?limit=20&type=pdf` means the 20 newest PDFs, not the PDFs among the 20
  // newest Files. Keys without an extension never match.
  const typeParam = params.get("type");
  const extensions = typeParam
    ? new Set(
        typeParam
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .flatMap((value) => TYPE_CATEGORIES[value] ?? [value]),
      )
    : null;
  const matchesType = (key: string) => extensions === null || extensions.has(extensionOf(key));

  // Visibility filter: "public" or "private" (anything else matches nothing).
  const visibilityParam = params.get("visibility");

  // R2 lists lexicographically with no reverse option, so walk the whole
  // prefix and sort afterwards; these are small personal buckets.
  const directories: string[] = [];
  const files: FileEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: prefix || undefined,
      delimiter,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const dir of page.delimitedPrefixes ?? []) {
      // The version namespace and reserved names stay out of the root
      // listing; deeper levels have nothing to hide.
      if (!prefix && (dir === "archive/" || RESERVED_TOP_LEVEL.includes(dir.slice(0, -1)))) continue;
      directories.push(dir);
    }
    for (const object of page.objects) {
      // Versions only show up in /api/versions/<key>.
      if (isArchiveKey(object.key)) continue;
      if (!prefix && RESERVED_TOP_LEVEL.includes(object.key.split("/")[0])) continue;
      if (!matches(object.customMetadata)) continue;
      if (!matchesType(object.key)) continue;
      const entry = fileEntryOf(object);
      if (visibilityParam !== null && entry.visibility !== visibilityParam) continue;
      files.push(entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  directories.sort();
  if (delimiter) files.sort((a, b) => a.key.localeCompare(b.key));
  else files.sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  return Response.json(
    { prefix, directories, files: files.slice(0, limit) },
    { headers: { "cache-control": "no-store" } },
  );
}

// GET /api/files/<key> - the File's metadata.
async function fileMeta(key: string, bucket: R2Bucket): Promise<Response> {
  const object = await bucket.head(key);
  if (!object) return new Response("not found\n", { status: 404 });
  const meta = object.customMetadata ?? {};
  return Response.json(
    {
      ...fileEntryOf(object),
      contentType: object.httpMetadata?.contentType,
      ...(meta.worktree && { worktree: meta.worktree }),
      ...(meta.dir && { dir: meta.dir }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// PATCH /api/files/<key> with {"visibility": "public"|"private"} flips the
// stamp via a metadata self-copy (R2 has no metadata-only update). Same key,
// same URL, no content change - so flips never archive anything.
async function patchFile(request: Request, key: string, bucket: R2Bucket): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { visibility?: unknown } | null;
  const value = body?.visibility;
  if (value !== "public" && value !== "private") {
    return new Response('body must be {"visibility": "public"} or {"visibility": "private"}\n', {
      status: 400,
    });
  }
  if (isArchiveKey(key)) {
    return new Response("Versions are always private\n", { status: 400 });
  }
  const object = await bucket.get(key);
  if (!object) return new Response("not found\n", { status: 404 });
  const meta = { ...object.customMetadata };
  if (value === "public") meta.visibility = "public";
  else delete meta.visibility;
  await bucket.put(key, object.body, { httpMetadata: object.httpMetadata, customMetadata: meta });
  return fileMeta(key, bucket);
}

// DELETE /api/files/<key> removes the whole identity: the File plus every
// Version under archive/<key>/. Deleting one Version by its own archive key
// prunes just that Version. Responds with the deleted keys.
async function deleteFile(key: string, bucket: R2Bucket): Promise<Response> {
  const deleted: string[] = [];
  if ((await bucket.head(key)) !== null) deleted.push(key);
  if (!isArchiveKey(key)) {
    const prefix = `archive/${key}/`;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        // Only direct children: deeper keys are the history of a nested
        // Stable Path, not Versions of this one.
        if (!object.key.slice(prefix.length).includes("/")) deleted.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (deleted.length === 0) return new Response("not found\n", { status: 404 });
  await bucket.delete(deleted);
  return Response.json({ deleted }, { headers: { "cache-control": "no-store" } });
}

// GET /api/versions/<key> - the File's current state plus its Versions,
// newest first. A top-level resource because Keys contain slashes: a
// /versions suffix on the Key would be unparseable.
async function listVersions(key: string, bucket: R2Bucket): Promise<Response> {
  const prefix = `archive/${key}/`;
  const versions: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of page.objects) {
      // Versions sit directly under the prefix; deeper keys belong to the
      // history of a nested Stable Path that has this one as a directory.
      if (object.key.slice(prefix.length).includes("/")) continue;
      versions.push({
        key: object.key,
        size: object.size,
        // When the Version was originally written, preserved at archive time
        // (the object's own `uploaded` is when it was archived).
        uploaded: object.customMetadata?.uploaded ?? object.uploaded.toISOString(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Timestamped archive keys sort lexicographically in chronological order.
  versions.sort((a, b) => b.key.localeCompare(a.key));
  const current = await bucket.head(key);
  return Response.json(
    {
      current: current ? { key, size: current.size, uploaded: current.uploaded.toISOString() } : null,
      versions,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// The /api machine surface. Anonymous requests get a plain 401, never the
// login redirect: /api is a Reserved Key whose existence is not secret, and
// a 302 to an HTML login page confuses API clients.
async function api(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  const path = decodeURIComponent(url.pathname);

  if (path === "/api/files" || path === "/api/files/") {
    if (request.method !== "GET") return new Response("method not allowed\n", { status: 405 });
    return listFiles(url, bucket);
  }
  if (path.startsWith("/api/files/")) {
    const key = path.slice("/api/files/".length).replace(/\/+$/, "");
    if (request.method === "GET") return fileMeta(key, bucket);
    if (request.method === "PATCH") return patchFile(request, key, bucket);
    if (request.method === "DELETE") return deleteFile(key, bucket);
    return new Response("method not allowed\n", { status: 405 });
  }
  if (path.startsWith("/api/versions/")) {
    if (request.method !== "GET") return new Response("method not allowed\n", { status: 405 });
    const key = path.slice("/api/versions/".length).replace(/\/+$/, "");
    return listVersions(key, bucket);
  }
  return new Response("not found\n", { status: 404 });
}

function objectHeaders(object: R2Object, publicObject: boolean): HeadersInit {
  // Private responses must never land in shared caches. Public Stable Paths
  // change in place, so they revalidate by etag; Generated Keys are
  // immutable.
  const stable = object.customMetadata?.stable === "true";
  return {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": !publicObject
      ? "private, no-store"
      : stable
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  };
}

function fileResponse(request: Request, object: R2Object, publicObject: boolean): Response {
  const headers = objectHeaders(object, publicObject);
  // head() results have no body; get() results do.
  const body = "body" in object ? (object as R2ObjectBody).body : null;
  if (request.method === "HEAD" || body === null) return new Response(null, { headers });
  return new Response(body, { headers });
}

// The browse-UI SPA shell (ui/dist/_/index.html via the ASSETS binding),
// served at the Directory Route's own URL so the app can read its location.
async function serveShell(request: Request, env: Env): Promise<Response> {
  const shell = await env.ASSETS.fetch(new URL("/_/", request.url));
  return new Response(request.method === "HEAD" ? null : shell.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

// GET/HEAD of any content path, resolved per docs/adr/0002: an exact Key
// match serves the File (public ones to anyone); every other path is a
// Directory Route - browse UI for authenticated browsers, plain 404 for
// authenticated non-HTML clients, the login redirect for everyone else.
async function resolve(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  const rawKey = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  // A trailing slash always means a Directory Route, so /pr-assets/ is the
  // listing even when a File named pr-assets exists.
  const trailingSlash = rawKey.endsWith("/");
  const key = rawKey.replace(/\/+$/, "");

  // Version alias: /<key>/archive/<stamp> serves archive/<key>/<stamp>.
  // Real archive/... Keys pass through untouched, and no other Key can
  // contain an archive segment (Reserved Key), so the rewrite is unambiguous.
  let lookupKey = key;
  if (!isArchiveKey(key)) {
    const alias = key.match(/^(.+)\/archive\/([^/]+)$/);
    if (alias) lookupKey = `archive/${alias[1]}/${alias[2]}`;
  }

  const object =
    key && !trailingSlash
      ? request.method === "HEAD"
        ? await bucket.head(lookupKey)
        : await bucket.get(lookupKey)
      : null;

  const publicObject = object !== null && isPublic(lookupKey, object.customMetadata);
  if (publicObject) return fileResponse(request, object, true);

  if (!(await isAuthenticated(request, env))) return loginRedirect(url);
  if (object) return fileResponse(request, object, false);

  // Directory Route (also /<key>/archive, whose history view lives in the
  // SPA). Only clients that accept text/html get the shell; scripted reads
  // keep 404 semantics instead of a 200 HTML page.
  if (request.headers.get("accept")?.includes("text/html")) return serveShell(request, env);
  return new Response("not found\n", { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const bucket = env.FILES;

    if (url.pathname === "/login") return login(request, env, url);
    // Every PUT/POST is an upload attempt - no system route accepts them - so
    // routing them first lets upload() reject Reserved Keys with the 400 that
    // names the reserved word instead of a generic 405.
    if (request.method === "PUT" || request.method === "POST") return upload(request, env, url, bucket);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return api(request, env, url, bucket);
    }
    // The UI asset bundle. Gated like everything else (fail closed): the only
    // legitimate consumer is the shell, which required auth to load.
    if (url.pathname === "/_" || url.pathname.startsWith("/_/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed\n", { status: 405 });
      }
      if (!(await isAuthenticated(request, env))) return loginRedirect(url);
      return env.ASSETS.fetch(request);
    }
    if (request.method === "GET" || request.method === "HEAD") return resolve(request, env, url, bucket);
    return new Response("method not allowed\n", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
