// File host for files.wovn.org (public) and private.wovn.org (Cloudflare
// Access-gated), used by the wovn-file-hosting skill. PUT/POST an authenticated
// file to any path; the response body is the permanent URL. GET serves
// stored objects. POST mints a collision-proof immutable key
// (yyyy/mm/<random>-<filename>); PUT writes the exact request path and
// refuses to overwrite an existing object unless the client forces it. A
// forced overwrite first copies the old version to archive/<path>/<stamp>, so
// stable paths keep their full history; GET /<path>?history lists it. The
// archive/ prefix is reserved (PUT rejects it) and hidden from /?list.
// Uploads carry the client's git context in x-wovn-* headers (see
// META_HEADERS), stored as customMetadata. GET /?list returns recent objects
// as JSON, newest first (authenticated); project/branch/worktree/dir query
// params filter on that stored context, and a type param filters by file type
// (see TYPE_CATEGORIES).
//
// The private host verifies the Access JWT itself (signature, issuer,
// audience, expiry) rather than trusting that the Access app is configured,
// so deleting or misconfiguring the Access app fails closed.

const PRIVATE_HOSTNAME = "private.wovn.org";

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

function isAuthorized(request: Request, token: string): boolean {
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(token);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
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

// Cloudflare Access JWT verification for the private host. The signing keys
// are public and rotate rarely; caching them module-level is config, not
// request state.
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

async function verifyAccessJwt(request: Request, env: Env): Promise<boolean> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return false;
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(b64urlDecode(parts[0]))) as { kid?: string };
    const payload = JSON.parse(decoder.decode(b64urlDecode(parts[1]))) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
    };
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return false;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return false;

    const jwk = (await accessSigningKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

async function upload(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  // Public host uploads authenticate with the bearer token; on the private
  // host the Access JWT check in fetch() has already established identity.
  if (url.hostname !== PRIVATE_HOSTNAME) {
    if (!env.FILE_HOST_TOKEN) return new Response("upload token not configured\n", { status: 503 });
    if (!isAuthorized(request, env.FILE_HOST_TOKEN)) return new Response("unauthorized\n", { status: 401 });
  }
  if (!request.body) return new Response("missing request body\n", { status: 400 });

  const customMetadata: Record<string, string> = {};
  for (const [header, name] of Object.entries(META_HEADERS)) {
    const value = request.headers.get(header);
    if (value) customMetadata[name] = value;
  }

  // POST mints an immutable dated key; PUT stores at the exact requested
  // path, so the URL stays stable across re-uploads.
  let key: string;
  if (request.method === "PUT") {
    const stable = stableKey(url.pathname);
    if (!stable) return new Response("PUT needs an explicit path\n", { status: 400 });
    if (stable === "archive" || stable.startsWith("archive/")) {
      return new Response("archive/ is reserved for previous versions of stable paths\n", { status: 400 });
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
      // time); `stable` is dropped - archived versions are immutable.
      const existing = await bucket.get(key);
      if (existing) {
        const meta = { ...existing.customMetadata };
        delete meta.stable;
        meta.uploaded = existing.uploaded.toISOString();
        await bucket.put(archiveKeyFor(key), existing.body, {
          httpMetadata: existing.httpMetadata,
          customMetadata: meta,
        });
      }
    }
  } else {
    key = objectKey(url.pathname);
  }

  const contentType = contentTypeFor(key, request.headers.get("content-type"));
  await bucket.put(key, request.body, { httpMetadata: { contentType }, customMetadata });
  return new Response(`https://${url.hostname}/${key}\n`, { status: 201 });
}

// GET /?list returns recent objects as JSON, newest first. Authenticated on
// both hosts: the private host is already behind the Access check, and the
// public listing requires the upload token - generated URLs are unguessable
// capability URLs, so an open listing would enumerate them.
async function list(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (url.hostname !== PRIVATE_HOSTNAME) {
    if (!env.FILE_HOST_TOKEN) return new Response("upload token not configured\n", { status: 503 });
    if (!isAuthorized(request, env.FILE_HOST_TOKEN)) return new Response("unauthorized\n", { status: 401 });
  }
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

  // R2 lists lexicographically with no reverse option, so walk the whole
  // bucket and sort by upload time; these are small personal buckets.
  const objects: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of page.objects) {
      // Archived previous versions only show up in per-path ?history.
      if (object.key.startsWith("archive/")) continue;
      if (!matches(object.customMetadata)) continue;
      if (!matchesType(object.key)) continue;
      objects.push({ key: object.key, size: object.size, uploaded: object.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  objects.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  return Response.json(objects.slice(0, limit), { headers: { "cache-control": "no-store" } });
}

// GET /<path>?history returns a stable path's current object plus its
// archived previous versions, newest first. Authenticated like /?list.
async function history(request: Request, env: Env, url: URL, bucket: R2Bucket): Promise<Response> {
  if (url.hostname !== PRIVATE_HOSTNAME) {
    if (!env.FILE_HOST_TOKEN) return new Response("upload token not configured\n", { status: 503 });
    if (!isAuthorized(request, env.FILE_HOST_TOKEN)) return new Response("unauthorized\n", { status: 401 });
  }
  const key = decodeURIComponent(url.pathname.slice(1));

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
  return Response.json(
    {
      current: current ? { key, size: current.size, uploaded: current.uploaded.toISOString() } : null,
      versions,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function objectHeaders(object: R2Object, isPrivate: boolean): HeadersInit {
  // Private files must never land in shared caches. Public stable objects
  // change in place, so they revalidate by etag; generated keys are immutable.
  const stable = object.customMetadata?.stable === "true";
  return {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": isPrivate
      ? "private, no-store"
      : stable
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  };
}

async function serve(request: Request, url: URL, bucket: R2Bucket): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key) return new Response("not found\n", { status: 404 });
  const isPrivate = url.hostname === PRIVATE_HOSTNAME;

  // HEAD reads only object metadata; GET streams the body from R2.
  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(null, { headers: objectHeaders(object, isPrivate) });
  }

  const object = await bucket.get(key);
  if (!object) return new Response("not found\n", { status: 404 });
  return new Response(object.body, { headers: objectHeaders(object, isPrivate) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    let bucket = env.FILES;
    if (url.hostname === PRIVATE_HOSTNAME) {
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
        return new Response("private host not configured\n", { status: 503 });
      }
      if (!(await verifyAccessJwt(request, env))) {
        return new Response("forbidden\n", { status: 403 });
      }
      bucket = env.PRIVATE;
    }

    if (request.method === "PUT" || request.method === "POST") return upload(request, env, url, bucket);
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("list")) {
      return list(request, env, url, bucket);
    }
    if (request.method === "GET" && url.pathname !== "/" && url.searchParams.has("history")) {
      return history(request, env, url, bucket);
    }
    if (request.method === "GET" || request.method === "HEAD") return serve(request, url, bucket);
    return new Response("method not allowed\n", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
