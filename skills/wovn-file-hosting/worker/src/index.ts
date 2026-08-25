// File host for files.wovn.org, used by the wovn-file-hosting skill. One
// hostname, one R2 bucket; every object carries its visibility in
// customMetadata and is private unless explicitly stamped
// `visibility: public` (fail closed). Objects under archive/ - previous
// versions of stable paths - are always private regardless of stamping.
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
// Serving is uniform fail-closed: a public object is served to anyone;
// anything else - private object or no object at all - 302s anonymous
// requests to /login, so probing leaks nothing about which keys exist.
//
// PUT/POST upload (authenticated); the response body is the permanent URL.
// POST mints a collision-proof immutable key (yyyy/mm/<random>-<filename>);
// PUT writes the exact request path and refuses to overwrite an existing
// object unless the client forces it. A forced overwrite first copies the old
// version to archive/<path>/<stamp>, so stable paths keep their full history,
// and preserves the old object's visibility unless the request explicitly
// restates it - updating a published document does not unpublish it.
// Reserved keys (RESERVED_KEYS) are rejected. Uploads carry the client's git
// context in x-wovn-* headers (see META_HEADERS), stored as customMetadata.
//
// GET /?list returns recent objects as JSON, newest first (authenticated);
// project/branch/worktree/dir params filter on stored git context, type
// filters by extension (TYPE_CATEGORIES), visibility=public|private filters
// on the stamp. GET /<path>?history lists a stable path's versions.
// GET /<path>?visibility and PATCH /<path>?visibility=public|private read and
// flip the stamp (a metadata self-copy; same key, same URL). DELETE /<path>
// removes the object and its whole archive/<path>/ history.
//
// /_ hosts the browse UI (authenticated like any private object; anonymous
// browsers round-trip through /login). GET /_/api/browse?prefix= lists one
// directory level; GET /_/api/history?key= is ?history for the UI; everything
// else under /_/ is served from the built SPA assets (ui/dist via the ASSETS
// binding). A bare GET / with no query redirects to /_/.

// Top-level key segments uploads may never claim: system routes and the
// version-history namespace. Grow this list when new routes are added.
const RESERVED_KEYS = ["archive", "login", "_"];

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

// Coarse file-type buckets for the `type` list filter, matched against the
// extension in the object key. Categories are deliberately non-overlapping so
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
// stored as customMetadata so /?list can filter by it.
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

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.some((r) => key === r || key.startsWith(`${r}/`));
}

// The single fail-closed visibility rule: public only when explicitly
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

// Stable keys (PUT) use the request path verbatim, sanitized per segment.
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

// Archived versions live under archive/<stable-path>/; the key structure is
// the whole history index (no metadata bookkeeping to drift out of sync), and
// the timestamp prefix makes lexicographic order chronological.
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
    if (isReservedKey(stable)) {
      return new Response(`${stable.split("/")[0]}/ is a reserved path\n`, { status: 400 });
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
      // A forced overwrite archives the version it replaces, keeping its
      // content type and git context. `uploaded` preserves when that version
      // was originally written (the copy's own timestamp is the archive
      // time); `stable` and `visibility` are dropped - archived versions are
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

// GET /?list returns recent objects as JSON, newest first. Authenticated:
// generated URLs are unguessable capability URLs, so the listing is never
// open, and private keys must not be enumerable.
async function list(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 1000);

  // Git-context filters (see META_HEADERS). Every provided filter must match;
  // objects uploaded without context (pre-tagging, or curl) never match.
  // "project" matches the project name or its full path, so both
  // `--project skills` and an inferred absolute path work.
  const filters = (["project", "branch", "worktree", "dir"] as const).flatMap((name) => {
    const value = url.searchParams.get(name);
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
  // newest files. Keys without an extension never match.
  const typeParam = url.searchParams.get("type");
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
  const visibilityParam = url.searchParams.get("visibility");

  // R2 lists lexicographically with no reverse option, so walk the whole
  // bucket and sort by upload time; these are small personal buckets.
  const objects: { key: string; size: number; uploaded: string; visibility: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of page.objects) {
      // Archived previous versions only show up in per-path ?history.
      if (isArchiveKey(object.key)) continue;
      if (!matches(object.customMetadata)) continue;
      if (!matchesType(object.key)) continue;
      const visibility = visibilityOf(object.key, object.customMetadata);
      if (visibilityParam !== null && visibility !== visibilityParam) continue;
      objects.push({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        visibility,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  objects.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  return Response.json(objects.slice(0, limit), { headers: { "cache-control": "no-store" } });
}

// A stable path's current object plus its archived previous versions, newest
// first. Shared by GET /<path>?history and the browse UI's /_/api/history.
async function historyOf(bucket: R2Bucket, key: string) {
  const prefix = `archive/${key}/`;
  const versions: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of page.objects) {
      // Versions sit directly under the prefix; deeper keys belong to the
      // history of a nested stable path that has this one as a directory.
      if (object.key.slice(prefix.length).includes("/")) continue;
      versions.push({
        key: object.key,
        size: object.size,
        // When the version was originally written, preserved at archive time
        // (the object's own `uploaded` is when it was archived).
        uploaded: object.customMetadata?.uploaded ?? object.uploaded.toISOString(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Timestamped archive keys sort lexicographically in chronological order.
  versions.sort((a, b) => b.key.localeCompare(a.key));
  const current = await bucket.head(key);
  return {
    current: current ? { key, size: current.size, uploaded: current.uploaded.toISOString() } : null,
    versions,
  };
}

// GET /<path>?history returns a stable path's current object plus its
// archived previous versions, newest first. Authenticated like /?list.
async function history(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  const key = decodeURIComponent(url.pathname.slice(1));
  return Response.json(await historyOf(bucket, key), { headers: { "cache-control": "no-store" } });
}

// GET /_/api/browse?prefix=<p> returns one directory level as
// {prefixes, files}: the sub-folder prefixes under <p> (sorted) and the files
// directly under it (newest first), via R2 delimited listing.
async function browse(url: URL, bucket: R2Bucket): Promise<Response> {
  const raw = url.searchParams.get("prefix") ?? "";
  const prefix = raw && !raw.endsWith("/") ? `${raw}/` : raw;

  const folders = new Set<string>();
  const files: {
    key: string;
    size: number;
    uploaded: string;
    visibility: string;
    stable: boolean;
    project?: string;
    branch?: string;
  }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      delimiter: "/",
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const p of page.delimitedPrefixes) folders.add(p);
    for (const object of page.objects) {
      files.push({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        visibility: visibilityOf(object.key, object.customMetadata),
        stable: object.customMetadata?.stable === "true",
        project: object.customMetadata?.project,
        branch: object.customMetadata?.branch,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // System namespaces (archive/ version history, reserved routes) never show
  // at the root; deeper levels cannot contain them because uploads reject
  // reserved top-level keys.
  const prefixes = [...folders].filter((p) => prefix !== "" || !isReservedKey(p.slice(0, -1))).sort();
  files.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  return Response.json({ prefixes, files }, { headers: { "cache-control": "no-store" } });
}

// GET /_ and /_/*: the browse UI. The API routes answer JSON about the
// bucket; every other path is served from the built SPA assets. Anonymous
// requests take the same /login round-trip as private objects (with the same
// cookie-refusal guard), so the UI is exactly as private as the files it
// lists.
async function ui(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) {
    if (url.searchParams.has(LOGIN_MARKER)) {
      return new Response("authentication requires cookies\n", { status: 403 });
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: `/login?to=${encodeURIComponent(url.pathname + url.search)}`,
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname === "/_/api/browse") return browse(url, bucket);
  if (url.pathname === "/_/api/history") {
    const key = url.searchParams.get("key");
    if (!key) return new Response("history needs a key parameter\n", { status: 400 });
    return Response.json(await historyOf(bucket, key), { headers: { "cache-control": "no-store" } });
  }
  // The SPA is built with base /_/ so its index lives at /_/; normalize the
  // bare /_ (asset serving would otherwise redirect, losing the query).
  if (url.pathname === "/_") {
    return new Response(null, {
      status: 302,
      headers: { location: `/_/${url.search}`, "cache-control": "no-store" },
    });
  }
  return env.ASSETS.fetch(request);
}

// GET /<path>?visibility prints the stamp; PATCH /<path>?visibility=<value>
// flips it via a metadata self-copy (R2 has no metadata-only update). Same
// key, same URL, no content change - so flips never archive anything.
async function visibility(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  const key = decodeURIComponent(url.pathname.slice(1));

  if (request.method === "GET") {
    const object = await bucket.head(key);
    if (!object) return new Response("not found\n", { status: 404 });
    return new Response(`${visibilityOf(key, object.customMetadata)}\n`, {
      headers: { "cache-control": "no-store" },
    });
  }

  const value = url.searchParams.get("visibility");
  if (value !== "public" && value !== "private") {
    return new Response("visibility must be public or private\n", { status: 400 });
  }
  if (isArchiveKey(key)) {
    return new Response("archived versions are always private\n", { status: 400 });
  }
  const object = await bucket.get(key);
  if (!object) return new Response("not found\n", { status: 404 });
  const meta = { ...object.customMetadata };
  if (value === "public") meta.visibility = "public";
  else delete meta.visibility;
  await bucket.put(key, object.body, { httpMetadata: object.httpMetadata, customMetadata: meta });
  return new Response(`https://${url.hostname}/${key}\n`, { headers: { "cache-control": "no-store" } });
}

// DELETE /<path> removes the whole identity: the object plus every archived
// version under archive/<path>/. Deleting one archived version by its own
// archive URL prunes just that version. Responds with the deleted keys.
async function remove(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return new Response("unauthorized\n", { status: 401 });
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key) return new Response("DELETE needs an explicit path\n", { status: 400 });

  const deleted: string[] = [];
  if ((await bucket.head(key)) !== null) deleted.push(key);
  if (!isArchiveKey(key)) {
    const prefix = `archive/${key}/`;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        // Only direct children: deeper keys are the history of a nested
        // stable path, not versions of this one.
        if (!object.key.slice(prefix.length).includes("/")) deleted.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (deleted.length === 0) return new Response("not found\n", { status: 404 });
  await bucket.delete(deleted);
  return Response.json({ deleted }, { headers: { "cache-control": "no-store" } });
}

function objectHeaders(object: R2Object, publicObject: boolean): HeadersInit {
  // Private responses must never land in shared caches. Public stable objects
  // change in place, so they revalidate by etag; generated keys are immutable.
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

// GET/HEAD of a key. Public objects are served to anyone. Everything else -
// a private object or a key that does not exist - is indistinguishable to an
// anonymous client: both redirect to /login, so nothing leaks.
async function serve(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(1));
  const object = key
    ? request.method === "HEAD"
      ? await bucket.head(key)
      : await bucket.get(key)
    : null;

  const publicObject = object !== null && isPublic(key, object.customMetadata);
  if (!publicObject && !(await isAuthenticated(request, env))) {
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
  if (!object) return new Response("not found\n", { status: 404 });

  const headers = objectHeaders(object, publicObject);
  // head() results have no body; get() results do.
  const body = "body" in object ? (object as R2ObjectBody).body : null;
  if (request.method === "HEAD" || body === null) return new Response(null, { headers });
  return new Response(body, { headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const bucket = env.FILES;

    if (url.pathname === "/login") return login(request, env, url);
    if (request.method === "PUT" || request.method === "POST") return upload(request, env, url, bucket);
    if (request.method === "PATCH") return visibility(request, env, url, bucket);
    if (request.method === "DELETE") return remove(request, env, url, bucket);
    if (request.method === "GET" || request.method === "HEAD") {
      // The browse UI. Non-GET methods fall through to the handlers above so
      // uploads to _/... still hit the reserved-key rejection.
      if (url.pathname === "/_" || url.pathname.startsWith("/_/")) {
        return ui(request, env, url, bucket);
      }
      if (url.pathname === "/") {
        if (url.searchParams.has("list")) return list(request, env, url, bucket);
        // The bare hostname in a browser lands in the UI.
        if (!url.search) {
          return new Response(null, {
            status: 302,
            headers: { location: "/_/", "cache-control": "no-store" },
          });
        }
      }
      if (url.pathname !== "/") {
        if (url.searchParams.has("history")) return history(request, env, url, bucket);
        if (url.searchParams.has("visibility")) return visibility(request, env, url, bucket);
      }
      return serve(request, env, url, bucket);
    }
    return new Response("method not allowed\n", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
