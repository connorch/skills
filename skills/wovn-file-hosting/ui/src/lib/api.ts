// Same-origin client for the worker's browse endpoints. Every call rides the
// wovn_auth cookie; when it is missing or expired the worker answers with a
// 302 to /login (API GETs) or 401/403, and we restart the login round-trip
// for the whole page so Access can mint a fresh cookie.

export interface BrowseFile {
  key: string
  size: number
  uploaded: string
  visibility: "public" | "private"
  stable: boolean
  project?: string
  branch?: string
}

export interface BrowseResult {
  prefixes: string[]
  files: BrowseFile[]
}

export interface HistoryVersion {
  key: string
  size: number
  uploaded: string
}

export interface HistoryResult {
  current: HistoryVersion | null
  versions: HistoryVersion[]
}

// The permanent URL a key is served at (segment-encoded; keys are sanitized
// on upload so this is normally the identity).
export function fileUrl(key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/")
  return new URL(`/${path}`, window.location.origin).toString()
}

function relogin(): never {
  const to = window.location.pathname + window.location.search
  window.location.assign(`/login?to=${encodeURIComponent(to)}`)
  throw new Error("redirecting to login")
}

// redirect: "manual" so an expired cookie surfaces as an opaque redirect
// instead of fetch chasing the interactive login flow.
async function request(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { redirect: "manual", ...init })
  if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) relogin()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res
}

export async function browse(prefix: string): Promise<BrowseResult> {
  const res = await request(`/_/api/browse?prefix=${encodeURIComponent(prefix)}`)
  return res.json()
}

export async function historyOf(key: string): Promise<HistoryResult> {
  const res = await request(`/_/api/history?key=${encodeURIComponent(key)}`)
  return res.json()
}

export async function setVisibility(key: string, visibility: "public" | "private"): Promise<void> {
  await request(`${fileUrl(key)}?visibility=${visibility}`, { method: "PATCH" })
}

// Removes the object plus its whole archived history (the worker's DELETE).
export async function deleteFile(key: string): Promise<void> {
  await request(fileUrl(key), { method: "DELETE" })
}
