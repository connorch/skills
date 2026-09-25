// Auth for files.wovn.org: two interchangeable credentials, checked by
// isAuthenticated().
//  - The WOVN_TOKEN bearer token (the wovn CLI and curl fallback).
//  - A Cloudflare Access JWT in a cookie, minted by the /login flow: the
//    Access application is path-scoped to files.wovn.org/login only, so the
//    Access edge intercepts just that path, runs the interactive login, and
//    injects `cf-access-jwt-assertion`; the /login handler copies that JWT
//    into a host-wide cookie and redirects back. Every other route verifies
//    the cookie itself (signature, issuer, audience, expiry), so a deleted or
//    misconfigured Access app fails closed. See docs/adr/0001.
import { env } from "cloudflare:workers"

const AUTH_COOKIE = "wovn_auth"
// Query marker appended by the /login redirect; if a request arrives with it
// and still has no valid cookie, the client refuses cookies - fail with 403
// instead of redirecting forever.
const LOGIN_MARKER = "wovn-authed"

function isTokenAuthorized(request: Request): boolean {
  const token = env.WOVN_TOKEN
  if (!token) return false
  const provided = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    ""
  )
  return constantTimeEqual(
    new TextEncoder().encode(provided),
    new TextEncoder().encode(token)
  )
}

// Compares every byte regardless of where the first difference is, so timing
// leaks nothing about the token.
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") ?? ""
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=")
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return part.slice(eq + 1).trim()
  }
  return undefined
}

// A request is authenticated with either the bearer token or a valid Access
// JWT cookie - our own relay cookie, or the CF_Authorization cookie Access
// itself sets on this hostname during the /login flow. Both credentials are
// equivalent everywhere; there are no per-route auth rules.
export async function isAuthenticated(request: Request): Promise<boolean> {
  if (isTokenAuthorized(request)) return true
  for (const name of [AUTH_COOKIE, "CF_Authorization"]) {
    const jwt = cookieValue(request, name)
    if (jwt && (await verifyJwt(jwt)) !== null) return true
  }
  return false
}

// The uniform response for anonymous requests to anything non-public: private
// File, Directory Route, or nothing at all - identical, so probing leaks
// nothing about which Keys exist. The whole URL (path and query) comes back
// after login, so `?raw` and `?version=` survive the bounce.
export function loginRedirect(url: URL): Response {
  // Arriving with the marker means we just came back from /login and the
  // cookie still is not there: the client refuses cookies, so redirecting
  // again would loop.
  if (url.searchParams.has(LOGIN_MARKER)) {
    return new Response("authentication requires cookies\n", { status: 403 })
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `/login?to=${encodeURIComponent(url.pathname + url.search)}`,
      "cache-control": "no-store",
    },
  })
}

// Cloudflare Access JWT verification. The signing keys are public and rotate
// rarely; caching them module-level is config, not request state.
let certsCache:
  { keys: (JsonWebKey & { kid?: string })[]; expires: number } | undefined

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function accessSigningKeys(teamDomain: string) {
  if (certsCache && certsCache.expires > Date.now()) return certsCache.keys
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`)
  const { keys } = await res.json<{ keys: (JsonWebKey & { kid?: string })[] }>()
  certsCache = { keys, expires: Date.now() + 3600_000 }
  return keys
}

// Full verification of an Access JWT: issuer, audience, expiry, signature.
// Returns the expiry (for cookie Max-Age) on success, null on any failure.
async function verifyJwt(jwt: string): Promise<{ exp: number } | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  try {
    const decoder = new TextDecoder()
    const header = JSON.parse(decoder.decode(b64urlDecode(parts[0]))) as {
      kid?: string
    }
    const payload = JSON.parse(decoder.decode(b64urlDecode(parts[1]))) as {
      iss?: string
      aud?: string | string[]
      exp?: number
    }
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.includes(env.ACCESS_AUD)) return null
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now())
      return null

    const jwk = (await accessSigningKeys(env.ACCESS_TEAM_DOMAIN)).find(
      (k) => k.kid === header.kid
    )
    if (!jwk) return null
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    )
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    )
    return valid ? { exp: payload.exp } : null
  } catch {
    return null
  }
}

// /login: the only Access-gated path. The Access edge has already forced the
// interactive login and injected the JWT; relay it into a host-wide cookie
// and bounce back to the requested URL. Without the Access app in front,
// there is no JWT and this fails closed.
export async function login(request: Request, url: URL): Promise<Response> {
  const jwt = request.headers.get("cf-access-jwt-assertion")
  if (!jwt) {
    return new Response(
      "login is not gated by a Cloudflare Access application; refusing\n",
      {
        status: 503,
      }
    )
  }
  const payload = await verifyJwt(jwt)
  if (!payload) return new Response("forbidden\n", { status: 403 })

  // `to` must be a same-origin absolute path ("/x", not "//host" or a URL).
  const to = url.searchParams.get("to") ?? "/"
  const dest = /^\/(?!\/)/.test(to) ? to : "/"
  const maxAge = Math.max(0, Math.floor(payload.exp - Date.now() / 1000))
  const separator = dest.includes("?") ? "&" : "?"
  return new Response(null, {
    status: 302,
    headers: {
      location: `${dest}${separator}${LOGIN_MARKER}=1`,
      "set-cookie": `${AUTH_COOKIE}=${jwt}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      "cache-control": "no-store",
    },
  })
}
