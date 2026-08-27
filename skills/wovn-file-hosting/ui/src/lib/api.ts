// Client for the worker's /api surface (see ../../../worker/src/index.ts and
// docs/adr/0002). Requests are same-origin: the wovn_auth cookie (browser) or
// an injected Authorization header (agent-browser) authenticates them.

export interface FileEntry {
  key: string
  size: number
  uploaded: string
  visibility: "public" | "private"
  stable: boolean
  project?: string
  branch?: string
}

export interface Listing {
  prefix: string
  directories: string[]
  files: FileEntry[]
}

export interface Version {
  key: string
  size: number
  uploaded: string
}

export interface Versions {
  current: Version | null
  versions: Version[]
}

// A 401/403 means the session expired: re-enter the /login flow for the page
// we are on instead of surfacing an error state.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (res.status === 401 || res.status === 403) {
    window.location.href = `/login?to=${encodeURIComponent(window.location.pathname)}`
    return new Promise<never>(() => {}) // navigation is in flight; never settles
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).trim()}`)
  return (await res.json()) as T
}

// One directory level under the prefix ("" = root). The limit is far above
// any real directory here; the worker would otherwise default to 20.
export function fetchListing(prefix: string): Promise<Listing> {
  const query = new URLSearchParams({ prefix, delimiter: "/", limit: "1000" })
  return request<Listing>(`/api/files?${query}`)
}

// Every File in the bucket (no delimiter, so no directories), newest first;
// the search palette matches and filters client-side. The limit is far above
// this personal bucket's size, and the worker caps at 1000 anyway.
export function fetchAllFiles(): Promise<Listing> {
  return request<Listing>("/api/files?limit=1000")
}

export function fetchVersions(key: string): Promise<Versions> {
  return request<Versions>(`/api/versions/${key}`)
}

export function setVisibility(
  key: string,
  visibility: "public" | "private"
): Promise<FileEntry> {
  return request<FileEntry>(`/api/files/${key}`, {
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

// The alias URL for a Version: /<key>/archive/<stamp> maps onto the stored
// archive/<key>/<stamp> Key (ADR 0002).
export function versionUrl(versionKey: string): string {
  const match = versionKey.match(/^archive\/(.+)\/([^/]+)$/)
  return match ? `/${match[1]}/archive/${match[2]}` : `/${versionKey}`
}
