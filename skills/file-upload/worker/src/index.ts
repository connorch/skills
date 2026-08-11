// File host for files.wovn.org, used by the file-upload skill.
// PUT/POST an authenticated file to any path; the response body is the
// permanent public URL. GET serves stored objects. Objects are keyed
// yyyy/mm/<random>-<filename>, so URLs are collision-proof and immutable.

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

async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.FILE_HOST_TOKEN) return new Response("upload token not configured\n", { status: 503 });
  if (!isAuthorized(request, env.FILE_HOST_TOKEN)) return new Response("unauthorized\n", { status: 401 });
  if (!request.body) return new Response("missing request body\n", { status: 400 });

  const key = objectKey(url.pathname);
  const contentType = contentTypeFor(key, request.headers.get("content-type"));
  await env.FILES.put(key, request.body, { httpMetadata: { contentType } });
  return new Response(`https://${url.hostname}/${key}\n`, { status: 201 });
}

function objectHeaders(object: R2Object): HeadersInit {
  return {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  };
}

async function serve(request: Request, env: Env, url: URL): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key) return new Response("not found\n", { status: 404 });

  // HEAD reads only object metadata; GET streams the body from R2.
  if (request.method === "HEAD") {
    const object = await env.FILES.head(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(null, { headers: objectHeaders(object) });
  }

  const object = await env.FILES.get(key);
  if (!object) return new Response("not found\n", { status: 404 });
  return new Response(object.body, { headers: objectHeaders(object) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "PUT" || request.method === "POST") return upload(request, env, url);
    if (request.method === "GET" || request.method === "HEAD") return serve(request, env, url);
    return new Response("method not allowed\n", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
