// File host for files.wovn.org (public) and private.wovn.org (Cloudflare
// Access-gated), used by the file-upload skill. PUT/POST an authenticated
// file to any path; the response body is the permanent URL. GET serves
// stored objects. Objects are keyed yyyy/mm/<random>-<filename>, so URLs
// are collision-proof and immutable.
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
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  zip: "application/zip",
};

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
  const slug = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${yyyy}/${mm}/${slug}-${filename}`;
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

  const key = objectKey(url.pathname);
  const contentType = contentTypeFor(key, request.headers.get("content-type"));
  await bucket.put(key, request.body, { httpMetadata: { contentType } });
  return new Response(`https://${url.hostname}/${key}\n`, { status: 201 });
}

function objectHeaders(object: R2Object, isPrivate: boolean): HeadersInit {
  return {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    // Private files must never land in shared caches; public URLs are immutable.
    "cache-control": isPrivate ? "private, no-store" : "public, max-age=31536000, immutable",
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
    if (request.method === "GET" || request.method === "HEAD") return serve(request, url, bucket);
    return new Response("method not allowed\n", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
