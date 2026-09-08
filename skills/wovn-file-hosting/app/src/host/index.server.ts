// The file host for files.wovn.org, run by src/server.ts ahead of the Start
// router (docs/adr/0004). Every request comes through host(); it either
// answers itself (Raw bytes, uploads, /api, /login, assets, redirects, the
// injected Banner) or hands an already-authenticated app page to Start with
// the resolved Page as request context. Everything Start sees is
// authenticated, so routes and loaders carry no auth checks.
//
// URL resolution (docs/adr/0002 and 0003): an exact Key match serves the
// File; any other GET path is a Directory Route. A public File is Raw for
// anyone; everything else - private File, Directory Route, or nothing at
// all - 302s anonymous requests to /login identically, so probing leaks
// nothing. An authenticated Document Navigation (Sec-Fetch-Dest: document,
// no ?raw) is the one request that gets the app: an HTML File with the
// Banner injected, or a File Page / Directory Route page rendered by Start.
// Every other authenticated request gets Raw, or a plain 404 for a path with
// no Key, so scripted reads keep error detection.
//
// Versions have three URL spellings that name the same object: the storage
// Key archive/<key>/<stamp>, the alias /<key>/archive/<stamp>, and
// /<key>?version=<stamp>. Raw serves all three; a Document Navigation to
// either path form 302s to the query form, which keeps the File's own path
// as the document base URL. /<key>/archive 302s to /<key>?versions.
import { env } from "cloudflare:workers"

import type { FilePage, Page } from "@/lib/types"
import { isAuthenticated, login, loginRedirect } from "./auth.server"
import { api } from "./api.server"
import {
  fileMetaOf,
  isArchiveKey,
  isPublic,
  listDirectory,
  listVersions,
  upload,
  versionOf,
} from "./files.server"
import { injectBanner } from "./inject.server"

// What host() hands back: a finished Response, or an app page for Start
// (`page` is absent for /_/ requests the asset binding does not know, which
// Start answers itself).
export type HostResult = Response | { page?: Page }

export async function host(request: Request): Promise<HostResult> {
  const url = new URL(request.url)

  if (url.pathname === "/login") return login(request, url)
  // Every PUT/POST is an upload attempt - no system route accepts them - so
  // routing them first lets upload() reject Reserved Keys with the 400 that
  // names the reserved word instead of a generic 405.
  if (request.method === "PUT" || request.method === "POST") {
    if (!(await isAuthenticated(request)))
      return new Response("unauthorized\n", { status: 401 })
    return upload(request, url)
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
    return api(request, url)
  // The app's own prefix: client assets and the Banner bundle from the
  // assets binding, anything else (server-function RPC) from Start. Gated
  // like everything else (fail closed): the only legitimate consumers are
  // pages that required auth to load.
  if (url.pathname === "/_" || url.pathname.startsWith("/_/")) {
    if (!(await isAuthenticated(request))) return loginRedirect(url)
    const asset = await env.ASSETS.fetch(request)
    return asset.status === 404 ? {} : asset
  }
  if (request.method === "GET" || request.method === "HEAD")
    return resolve(request, url)
  return new Response("method not allowed\n", { status: 405 })
}

// The one rule (docs/adr/0003): only an authenticated GET that the browser
// will render as its top-level document, without ?raw, gets the app.
function isDocumentNavigation(request: Request, url: URL): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    !url.searchParams.has("raw")
  )
}

function redirect(to: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: to, "cache-control": "no-store" },
  })
}

const NOT_FOUND = () => new Response("not found\n", { status: 404 })

async function resolve(request: Request, url: URL): Promise<HostResult> {
  const rawKey = decodeURIComponent(url.pathname).replace(/^\/+/, "")
  // A trailing slash always means a Directory Route, so /pr-assets/ is the
  // listing even when a File named pr-assets exists.
  const trailingSlash = rawKey.endsWith("/")
  const key = rawKey.replace(/\/+$/, "")
  const wrap = isDocumentNavigation(request, url)

  // Which File, and which of its Versions if any, the URL names. A Version
  // spelled in the path wins over ?version=; `archive` is a Reserved Key in
  // every segment, so the alias match is unambiguous.
  let fileKey = key
  let stamp: string | null = null
  let versionInPath = false
  if (key && !trailingSlash) {
    const spelled = isArchiveKey(key)
      ? key.match(/^archive\/(.+)\/([^/]+)$/)
      : key.match(/^(.+)\/archive\/([^/]+)$/)
    if (spelled) {
      fileKey = spelled[1]
      stamp = spelled[2]
      versionInPath = true
    } else {
      stamp = url.searchParams.get("version")
    }
  }
  const lookupKey = stamp ? `archive/${fileKey}/${stamp}` : key
  // /<key>/archive with nothing after it names the File's Versions.
  const archiveIndex =
    key && !trailingSlash && !isArchiveKey(key)
      ? key.match(/^(.+)\/archive$/)
      : null

  const object =
    key && !trailingSlash && !archiveIndex
      ? request.method === "HEAD"
        ? await env.FILES.head(lookupKey)
        : await env.FILES.get(lookupKey)
      : null

  const publicObject =
    object !== null && isPublic(lookupKey, object.customMetadata)
  if (publicObject && !wrap) return fileResponse(request, object, true)

  if (!(await isAuthenticated(request))) {
    return publicObject
      ? fileResponse(request, object, true)
      : loginRedirect(url)
  }
  if (!wrap)
    return object ? fileResponse(request, object, publicObject) : NOT_FOUND()

  // An authenticated Document Navigation from here on.
  if (archiveIndex) return redirect(`/${archiveIndex[1]}?versions`)
  if (object === null) {
    if (stamp) return NOT_FOUND()
    return {
      page: {
        kind: "directory",
        listing: await listDirectory(key ? `${key}/` : ""),
      },
    }
  }
  if (versionInPath)
    return redirect(`/${fileKey}?version=${encodeURIComponent(stamp!)}`)

  // A Version of a File that no longer exists has no File Page; serve it Raw.
  const current = stamp ? await env.FILES.head(fileKey) : object
  if (!current) return fileResponse(request, object, false)

  const page: FilePage = {
    kind: "file",
    file: fileMetaOf(current),
    versions: await listVersions(fileKey),
    version: stamp
      ? {
          ...versionOf(object),
          contentType:
            object.httpMetadata?.contentType ?? "application/octet-stream",
        }
      : null,
    openVersions: url.searchParams.has("versions"),
  }
  const contentType = object.httpMetadata?.contentType ?? ""
  if (/^text\/html\b/i.test(contentType) && hasBody(object))
    return injectBanner(object, page)
  return { page }
}

// head() results have no body; get() results do.
function hasBody(object: R2Object): object is R2ObjectBody {
  return "body" in object
}

function objectHeaders(object: R2Object, publicObject: boolean): HeadersInit {
  // Private responses must never land in shared caches. Public Stable Paths
  // change in place, so they revalidate by etag; Generated Keys are
  // immutable. One URL has two representations (Raw and the app), so Raw
  // varies on the request destination and on the session cookie: an
  // anonymous navigation to a public PNG caches immutable bytes, and a later
  // logged-in navigation sends the same destination header.
  const stable = object.customMetadata?.stable === "true"
  return {
    "content-type":
      object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    "cache-control": !publicObject
      ? "private, no-store"
      : stable
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable",
    etag: object.httpEtag,
    vary: "Sec-Fetch-Dest, Cookie",
  }
}

// Raw: the File's stored bytes and headers, unchanged.
function fileResponse(
  request: Request,
  object: R2Object,
  publicObject: boolean
): Response {
  const headers = objectHeaders(object, publicObject)
  if (request.method === "HEAD" || !hasBody(object))
    return new Response(null, { headers })
  return new Response(object.body, { headers })
}
