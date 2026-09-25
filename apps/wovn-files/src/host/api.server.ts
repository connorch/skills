// The /api machine surface (docs/adr/0002), REST over files.server.ts.
// Anonymous requests get a plain 401, never the login redirect: /api is a
// Reserved Key whose existence is not secret, and a 302 to an HTML login
// page confuses API clients.
//   GET /api/files                - the collection; ?prefix=&delimiter=/ is
//     one directory level (browse), project/branch/worktree/dir/type/
//     visibility/limit compose as filters (list), newest first when not
//     browsing.
//   GET|PATCH|DELETE /api/files/<key> - metadata; {"visibility": ...} flips
//     the stamp; DELETE removes the File and all its Versions.
//   GET /api/versions/<key>       - the File's Versions, newest first.
import { isAuthenticated } from "./auth.server"
import {
  deleteFile,
  fileMeta,
  isArchiveKey,
  listFiles,
  setVisibility,
  versionsOf,
} from "./files.server"

const NO_STORE = { "cache-control": "no-store" }

export async function api(request: Request, url: URL): Promise<Response> {
  if (!(await isAuthenticated(request)))
    return new Response("unauthorized\n", { status: 401 })
  const path = decodeURIComponent(url.pathname)

  if (path === "/api/files" || path === "/api/files/") {
    if (request.method !== "GET")
      return new Response("method not allowed\n", { status: 405 })
    return Response.json(await listFiles(url.searchParams), {
      headers: NO_STORE,
    })
  }
  if (path.startsWith("/api/files/")) {
    const key = path.slice("/api/files/".length).replace(/\/+$/, "")
    if (request.method === "GET") return metaResponse(key)
    if (request.method === "PATCH") return patch(request, key)
    if (request.method === "DELETE") {
      const deleted = await deleteFile(key)
      if (deleted.length === 0)
        return new Response("not found\n", { status: 404 })
      return Response.json({ deleted }, { headers: NO_STORE })
    }
    return new Response("method not allowed\n", { status: 405 })
  }
  if (path.startsWith("/api/versions/")) {
    if (request.method !== "GET")
      return new Response("method not allowed\n", { status: 405 })
    const key = path.slice("/api/versions/".length).replace(/\/+$/, "")
    return Response.json(await versionsOf(key), { headers: NO_STORE })
  }
  return new Response("not found\n", { status: 404 })
}

async function metaResponse(key: string): Promise<Response> {
  const meta = await fileMeta(key)
  if (!meta) return new Response("not found\n", { status: 404 })
  return Response.json(meta, { headers: NO_STORE })
}

async function patch(request: Request, key: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    visibility?: unknown
  } | null
  const value = body?.visibility
  if (value !== "public" && value !== "private") {
    return new Response(
      'body must be {"visibility": "public"} or {"visibility": "private"}\n',
      {
        status: 400,
      }
    )
  }
  if (isArchiveKey(key))
    return new Response("Versions are always private\n", { status: 400 })
  const meta = await setVisibility(key, value)
  if (!meta) return new Response("not found\n", { status: 404 })
  return Response.json(meta, { headers: NO_STORE })
}
