// Client for the host's /api surface (src/host/api.server.ts, docs/adr/0002)
// and the URL forms of a File (docs/adr/0003). Requests are same-origin: the
// wovn_auth cookie (browser) or an injected Authorization header
// (agent-browser) authenticates them. Used identically by app pages and by
// the Banner injected into HTML Files.
import type {
  FileEntry,
  FileMeta,
  Listing,
  Versions,
  Visibility,
} from "./types"

// A 401/403 means the session expired: re-enter the /login flow for the page
// we are on instead of surfacing an error state.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (res.status === 401 || res.status === 403) {
    window.location.href = `/login?to=${encodeURIComponent(window.location.pathname + window.location.search)}`
    return new Promise<never>(() => {}) // navigation is in flight; never settles
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).trim()}`)
  return (await res.json()) as T
}

// One directory level under the prefix ("" = root). The limit is far above
// any real directory here; the host would otherwise default to 20.
export function fetchListing(prefix: string): Promise<Listing> {
  const query = new URLSearchParams({ prefix, delimiter: "/", limit: "1000" })
  return request<Listing>(`/api/files?${query}`)
}

// Every File in the bucket (no delimiter, so no directories), newest first;
// the search palette matches and filters client-side. The limit is far above
// this personal bucket's size, and the host caps at 1000 anyway.
export function fetchAllFiles(): Promise<Listing> {
  return request<Listing>("/api/files?limit=1000")
}

export function fetchFile(key: string): Promise<FileMeta> {
  return request<FileMeta>(`/api/files/${key}`)
}

export function fetchVersions(key: string): Promise<Versions> {
  return request<Versions>(`/api/versions/${key}`)
}

export function setVisibility(
  key: string,
  visibility: Visibility
): Promise<FileMeta> {
  return request<FileMeta>(`/api/files/${key}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  })
}

export function deleteFile(key: string): Promise<{ deleted: string[] }> {
  return request<{ deleted: string[] }>(`/api/files/${key}`, {
    method: "DELETE",
  })
}

// The File's own URL, which a logged-in browser renders as its File Page.
export function fileUrl(key: string): string {
  return `/${key}`
}

// Raw: the stored bytes of the File, or of one of its Versions.
export function rawUrl(key: string, stamp?: string): string {
  return stamp
    ? `/${key}?version=${encodeURIComponent(stamp)}&raw`
    : `/${key}?raw`
}

// The File Page for a Version (docs/adr/0003).
export function versionUrl(key: string, stamp: string): string {
  return `/${key}?version=${encodeURIComponent(stamp)}`
}

// The Directory Route of the File's parent ("/" at the root).
export function parentUrl(key: string): string {
  return `/${key.replace(/[^/]*$/, "")}`
}

export function absoluteUrl(path: string): string {
  return `${window.location.origin}${path}`
}

export type { FileEntry }
