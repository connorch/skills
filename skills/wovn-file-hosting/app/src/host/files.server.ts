// The R2 side of the file host: one bucket, every File carrying its
// Visibility in customMetadata and private unless explicitly stamped
// `visibility: public` (fail closed). Objects under archive/ - Versions of
// Stable Paths - are always private regardless of stamping. These are plain
// data functions; /api (api.server.ts) and the page resolver
// (index.server.ts) are the two callers.
import { env } from "cloudflare:workers"

import type {
  FileEntry,
  FileMeta,
  Listing,
  Version,
  Versions,
  Visibility,
} from "@/lib/types"

const bucket = () => env.FILES

// Top-level Key segments uploads may never claim: live system routes plus
// deliberately over-reserved future surfaces (docs/adr/0002) - permanent URLs
// make later collisions expensive, reserving costs nothing.
export const RESERVED_TOP_LEVEL = [
  "login",
  "_", // the app's client assets, Banner bundle, and server-function RPC
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
]

// The reserved word an upload key violates, or null. `archive` is a Reserved
// Key in EVERY segment (not just top-level) so the /<key>/archive alias
// routes can never be shadowed by a real File.
function reservedWordIn(key: string): string | null {
  const segments = key.split("/")
  if (segments.includes("archive")) return "archive"
  return RESERVED_TOP_LEVEL.includes(segments[0]) ? segments[0] : null
}

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
}

// Coarse file-type buckets for the `type` filter, matched against the
// extension in the Key. Categories are deliberately non-overlapping so
// combining them stays easy to reason about; anything not covered here is
// still filterable by passing the bare extension. Mirrored in lib/search.ts
// for the client-side palette.
const TYPE_CATEGORIES: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
  video: ["mp4", "webm", "mov"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "md", "html", "txt", "log"],
  data: ["json", "csv", "yaml", "yml"],
  archive: ["zip", "tar", "gz", "tgz"],
}

// The lowercased extension of a key's final segment, or "" when it has none.
function extensionOf(key: string): string {
  const name = key.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

// Git context the wovn CLI infers at upload time and sends as headers;
// stored as customMetadata so /api/files can filter by it.
const META_HEADERS = {
  "x-wovn-dir": "dir",
  "x-wovn-branch": "branch",
  "x-wovn-worktree": "worktree",
  "x-wovn-project": "project",
  "x-wovn-project-path": "projectPath",
} as const

function contentTypeFor(filename: string, headerValue: string | null): string {
  if (headerValue && headerValue !== "application/octet-stream")
    return headerValue
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

export function isArchiveKey(key: string): boolean {
  return key === "archive" || key.startsWith("archive/")
}

// The single fail-closed Visibility rule: public only when explicitly
// stamped, and never under archive/.
export function isPublic(
  key: string,
  meta: Record<string, string> | undefined
): boolean {
  return !isArchiveKey(key) && meta?.visibility === "public"
}

function visibilityOf(
  key: string,
  meta: Record<string, string> | undefined
): Visibility {
  return isPublic(key, meta) ? "public" : "private"
}

// Stable Paths (PUT) use the request path verbatim, sanitized per segment.
function stableKey(pathname: string): string | null {
  const key = decodeURIComponent(pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "-"))
    .join("/")
  return key || null
}

function randomSlug(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function objectKey(pathname: string): string {
  const filename =
    decodeURIComponent(pathname)
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "-") || "file"
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `${yyyy}/${mm}/${randomSlug()}-${filename}`
}

// Versions live under archive/<stable-path>/; the key structure is the whole
// history index (no metadata bookkeeping to drift out of sync), and the
// timestamp prefix makes lexicographic order chronological.
function archiveKeyFor(key: string): string {
  const stamp = new Date().toISOString().toLowerCase().replace(/[:.]/g, "-")
  return `archive/${key}/${stamp}-${randomSlug()}`
}

// PUT/POST upload (already authenticated); the response body is the
// permanent URL. POST mints a collision-proof immutable Generated Key
// (yyyy/mm/<random>-<filename>); PUT writes the exact request path (a Stable
// Path) and refuses to overwrite an existing File unless the client forces
// it. A forced overwrite first copies the old state to
// archive/<path>/<stamp>, so Stable Paths keep their full history, and
// preserves the old File's Visibility unless the request explicitly restates
// it - updating a published document does not unpublish it. Reserved Keys
// are rejected with a message naming the reserved word. Uploads carry the
// client's git context in x-wovn-* headers (see META_HEADERS), stored as
// customMetadata.
export async function upload(request: Request, url: URL): Promise<Response> {
  if (!request.body)
    return new Response("missing request body\n", { status: 400 })

  const customMetadata: Record<string, string> = {}
  for (const [header, name] of Object.entries(META_HEADERS)) {
    const value = request.headers.get(header)
    if (value) customMetadata[name] = value
  }
  // Fail closed: public only on an explicit request. An absent or unknown
  // header value means private (no stamp at all).
  const requestedVisibility = request.headers.get("x-wovn-visibility")
  if (requestedVisibility === "public") customMetadata.visibility = "public"

  // POST mints an immutable dated key; PUT stores at the exact requested
  // path, so the URL stays stable across re-uploads.
  let key: string
  if (request.method === "PUT") {
    const stable = stableKey(url.pathname)
    if (!stable)
      return new Response("PUT needs an explicit path\n", { status: 400 })
    const reserved = reservedWordIn(stable)
    if (reserved) {
      return new Response(
        `${reserved} is a reserved name; pick a different path\n`,
        {
          status: 400,
        }
      )
    }
    key = stable
    customMetadata.stable = "true"
    // Overwrites are opt-in (the CLI's --force sets the header). Enforced
    // here, not just in the CLI, so no client can clobber a path by accident.
    if (request.headers.get("x-wovn-force") !== "1") {
      if ((await bucket().head(key)) !== null) {
        return new Response(
          `${key} already exists; pass --force to replace it\n`,
          { status: 409 }
        )
      }
    } else {
      // A forced overwrite archives the Version it replaces, keeping its
      // content type and git context. `uploaded` preserves when that Version
      // was originally written (the copy's own timestamp is the archive
      // time); `stable` and `visibility` are dropped - Versions are
      // immutable and always private.
      const existing = await bucket().get(key)
      if (existing) {
        const meta = { ...existing.customMetadata }
        delete meta.stable
        delete meta.visibility
        meta.uploaded = existing.uploaded.toISOString()
        await bucket().put(archiveKeyFor(key), existing.body, {
          httpMetadata: existing.httpMetadata,
          customMetadata: meta,
        })
        // Visibility is an attribute of the path, not of one upload: updating
        // a published document must not silently unpublish it. The request
        // can still restate it explicitly ("public" or "private") to flip.
        if (
          requestedVisibility !== "public" &&
          requestedVisibility !== "private"
        ) {
          if (existing.customMetadata?.visibility === "public")
            customMetadata.visibility = "public"
        }
      }
    }
  } else {
    key = objectKey(url.pathname)
  }

  const contentType = contentTypeFor(key, request.headers.get("content-type"))
  await bucket().put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata,
  })
  return new Response(`https://${url.hostname}/${key}\n`, { status: 201 })
}

function fileEntryOf(object: R2Object): FileEntry {
  const meta = object.customMetadata
  return {
    key: object.key,
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    visibility: visibilityOf(object.key, meta),
    stable: meta?.stable === "true",
    ...(meta?.project && { project: meta.project }),
    ...(meta?.branch && { branch: meta.branch }),
  }
}

export function fileMetaOf(object: R2Object): FileMeta {
  const meta = object.customMetadata ?? {}
  return {
    ...fileEntryOf(object),
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    ...(meta.worktree && { worktree: meta.worktree }),
    ...(meta.dir && { dir: meta.dir }),
  }
}

// The collection. `prefix` + `delimiter` browse one directory level;
// project/branch/worktree/dir (git context), type (extension), and
// visibility filter; `limit` caps the result. Filters compose. Browse
// results sort by name, everything else newest first.
export async function listFiles(params: URLSearchParams): Promise<Listing> {
  const limit = Math.min(Math.max(Number(params.get("limit")) || 20, 1), 1000)
  const prefix = params.get("prefix") ?? ""
  const delimiter = params.get("delimiter") ?? undefined

  // Git-context filters (see META_HEADERS). Every provided filter must match;
  // Files uploaded without context (pre-tagging, or curl) never match.
  // "project" matches the project name or its full path, so both
  // `--project skills` and an inferred absolute path work.
  const filters = (["project", "branch", "worktree", "dir"] as const).flatMap(
    (name) => {
      const value = params.get(name)
      return value === null ? [] : [{ name, value }]
    }
  )
  const matches = (meta: Record<string, string> | undefined) =>
    filters.every(({ name, value }) =>
      name === "project"
        ? meta?.project === value || meta?.projectPath === value
        : meta?.[name] === value
    )

  // File-type filter: comma-separated categories (see TYPE_CATEGORIES) and/or
  // bare extensions, OR'd together. Applied before the limit slice, so
  // `?limit=20&type=pdf` means the 20 newest PDFs, not the PDFs among the 20
  // newest Files. Keys without an extension never match.
  const typeParam = params.get("type")
  const extensions = typeParam
    ? new Set(
        typeParam
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .flatMap((value) => TYPE_CATEGORIES[value] ?? [value])
      )
    : null
  const matchesType = (key: string) =>
    extensions === null || extensions.has(extensionOf(key))

  // Visibility filter: "public" or "private" (anything else matches nothing).
  const visibilityParam = params.get("visibility")

  // R2 lists lexicographically with no reverse option, so walk the whole
  // prefix and sort afterwards; these are small personal buckets.
  const directories: string[] = []
  const files: FileEntry[] = []
  let cursor: string | undefined
  do {
    const page = await bucket().list({
      prefix: prefix || undefined,
      delimiter,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    })
    for (const dir of page.delimitedPrefixes ?? []) {
      // The version namespace and reserved names stay out of the root
      // listing; deeper levels have nothing to hide.
      if (
        !prefix &&
        (dir === "archive/" || RESERVED_TOP_LEVEL.includes(dir.slice(0, -1)))
      )
        continue
      directories.push(dir)
    }
    for (const object of page.objects) {
      // Versions only show up in /api/versions/<key>.
      if (isArchiveKey(object.key)) continue
      if (!prefix && RESERVED_TOP_LEVEL.includes(object.key.split("/")[0]))
        continue
      if (!matches(object.customMetadata)) continue
      if (!matchesType(object.key)) continue
      const entry = fileEntryOf(object)
      if (visibilityParam !== null && entry.visibility !== visibilityParam)
        continue
      files.push(entry)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  directories.sort()
  if (delimiter) files.sort((a, b) => a.key.localeCompare(b.key))
  else files.sort((a, b) => b.uploaded.localeCompare(a.uploaded))

  return { prefix, directories, files: files.slice(0, limit) }
}

// One directory level under the prefix ("" = root), as the browse UI needs it.
export function listDirectory(prefix: string): Promise<Listing> {
  return listFiles(
    new URLSearchParams({ prefix, delimiter: "/", limit: "1000" })
  )
}

export async function fileMeta(key: string): Promise<FileMeta | null> {
  const object = await bucket().head(key)
  return object ? fileMetaOf(object) : null
}

// Flips the stamp via a metadata self-copy (R2 has no metadata-only update).
// Same key, same URL, no content change - so flips never archive anything.
// Versions are always private, so archive Keys are refused.
export async function setVisibility(
  key: string,
  value: Visibility
): Promise<FileMeta | null> {
  const object = await bucket().get(key)
  if (!object) return null
  const meta = { ...object.customMetadata }
  if (value === "public") meta.visibility = "public"
  else delete meta.visibility
  await bucket().put(key, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: meta,
  })
  return fileMeta(key)
}

// Removes the whole identity: the File plus every Version under
// archive/<key>/. Deleting one Version by its own archive key prunes just
// that Version. Returns the deleted keys (empty when nothing existed).
export async function deleteFile(key: string): Promise<string[]> {
  const deleted: string[] = []
  if ((await bucket().head(key)) !== null) deleted.push(key)
  if (!isArchiveKey(key)) {
    const prefix = `archive/${key}/`
    let cursor: string | undefined
    do {
      const page = await bucket().list({ prefix, cursor, limit: 1000 })
      for (const object of page.objects) {
        // Only direct children: deeper keys are the history of a nested
        // Stable Path, not Versions of this one.
        if (!object.key.slice(prefix.length).includes("/"))
          deleted.push(object.key)
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  if (deleted.length > 0) await bucket().delete(deleted)
  return deleted
}

// A File's Versions, newest first.
export async function listVersions(key: string): Promise<Version[]> {
  const prefix = `archive/${key}/`
  const versions: Version[] = []
  let cursor: string | undefined
  do {
    const page = await bucket().list({
      prefix,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    })
    for (const object of page.objects) {
      // Versions sit directly under the prefix; deeper keys belong to the
      // history of a nested Stable Path that has this one as a directory.
      if (object.key.slice(prefix.length).includes("/")) continue
      versions.push(versionOf(object))
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  // Timestamped archive keys sort lexicographically in chronological order.
  versions.sort((a, b) => b.key.localeCompare(a.key))
  return versions
}

export function versionOf(object: R2Object): Version {
  return {
    key: object.key,
    size: object.size,
    // When the Version was originally written, preserved at archive time
    // (the object's own `uploaded` is when it was archived).
    uploaded: object.customMetadata?.uploaded ?? object.uploaded.toISOString(),
  }
}

// The File's current state plus its Versions (GET /api/versions/<key>).
export async function versionsOf(key: string): Promise<Versions> {
  const [versions, current] = await Promise.all([
    listVersions(key),
    bucket().head(key),
  ])
  return {
    current: current
      ? { key, size: current.size, uploaded: current.uploaded.toISOString() }
      : null,
    versions,
  }
}
