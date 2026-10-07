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
// A third credential identifies a Guest, not Connor (ADR 0005): a JWT from
// the second Access app at /guest (one-time PIN, anyone), relayed into its
// own cookie by the same flow. Its audience differs, so it never passes
// isAuthenticated(); guestEmail() reads it, and the resolver compares that
// email against the File's Share.
import { env } from "cloudflare:workers";

// One Access-gated path per credential: the app, the cookie the JWT is
// relayed into, and the query marker the redirect back appends. A request
// arriving with the marker and still no valid cookie means the client
// refuses cookies - fail with 403 instead of redirecting forever.
interface Relay {
  path: "/login" | "/guest";
  aud: () => string | undefined;
  cookie: string;
  marker: string;
}

const OWNER: Relay = {
  path: "/login",
  aud: () => env.ACCESS_AUD,
  cookie: "wovn_auth",
  marker: "wovn-authed",
};

const GUEST: Relay = {
  path: "/guest",
  aud: () => env.GUEST_AUD,
  cookie: "wovn_guest",
  marker: "wovn-guest",
};

function isTokenAuthorized(request: Request): boolean {
  const token = env.WOVN_TOKEN;
  if (!token) return false;
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return constantTimeEqual(new TextEncoder().encode(provided), new TextEncoder().encode(token));
}

// Compares every byte regardless of where the first difference is, so timing
// leaks nothing about the token.
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// A request is authenticated with either the bearer token or a valid Access
// JWT cookie - our own relay cookie, or the CF_Authorization cookie Access
// itself sets on this hostname during the /login flow. Both credentials are
// equivalent everywhere; there are no per-route auth rules.
export async function isAuthenticated(request: Request): Promise<boolean> {
  if (isTokenAuthorized(request)) return true;
  for (const name of [OWNER.cookie, "CF_Authorization"]) {
    const jwt = cookieValue(request, name);
    if (jwt && (await verifyJwt(jwt, OWNER.aud())) !== null) return true;
  }
  return false;
}

// The Guest's email (lowercased) when the request carries a valid Guest
// cookie, else null. Says nothing about which Files the Guest may read.
export async function guestEmail(request: Request): Promise<string | null> {
  const jwt = cookieValue(request, GUEST.cookie);
  const payload = jwt ? await verifyJwt(jwt, GUEST.aud()) : null;
  return payload?.email?.toLowerCase() ?? null;
}

// The uniform response for anonymous requests to anything non-public: private
// File, Directory Route, or nothing at all - identical, so probing leaks
// nothing about which Keys exist. The whole URL (path and query) comes back
// after login, so `?raw` and `?version=` survive the bounce.
export function loginRedirect(url: URL): Response {
  return relayRedirect(OWNER, url);
}

// The response for a request without a Guest cookie to a shared File: the
// Guest Login, which then bounces back here. Unlike loginRedirect this does
// reveal that a shared File exists at the URL (ADR 0005).
export function guestRedirect(url: URL): Response {
  return relayRedirect(GUEST, url);
}

// The URL without the Guest marker, or null when it carries none. A Guest
// gets Raw with no app to tidy the address bar (the Banner strips the owner
// marker client-side), so the resolver bounces once to this clean URL; a
// bookmarked link then starts a fresh Guest Login after the cookie expires
// instead of hitting the cookies-refused 403.
export function withoutGuestMarker(url: URL): string | null {
  if (!url.searchParams.has(GUEST.marker)) return null;
  const clean = new URL(url);
  clean.searchParams.delete(GUEST.marker);
  return clean.pathname + clean.search;
}

// The Set-Cookie that drops the Guest cookie, for the not-shared 403: the
// next visit then starts a fresh Guest Login.
export function forgetGuestCookie(): string {
  return `${GUEST.cookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function relayRedirect(relay: Relay, url: URL): Response {
  // Arriving with the marker means we just came back from the Access path
  // and the cookie still is not there: the client refuses cookies, so
  // redirecting again would loop.
  if (url.searchParams.has(relay.marker)) {
    return new Response("authentication requires cookies\n", { status: 403 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `${relay.path}?to=${encodeURIComponent(url.pathname + url.search)}`,
      "cache-control": "no-store",
    },
  });
}

// Cloudflare Access JWT verification. The signing keys are public and rotate
// rarely; caching them module-level is config, not request state.
let certsCache: { keys: (JsonWebKey & { kid?: string })[]; expires: number } | undefined;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
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

// Full verification of an Access JWT against one app's audience: issuer,
// audience, expiry, signature. Returns the expiry (for cookie Max-Age) and
// the email Access authenticated on success, null on any failure.
async function verifyJwt(
  jwt: string,
  aud: string | undefined,
): Promise<{ exp: number; email?: string } | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !aud) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(b64urlDecode(parts[0]))) as {
      kid?: string;
    };
    const payload = JSON.parse(decoder.decode(b64urlDecode(parts[1]))) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      email?: string;
    };
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;

    const jwk = (await accessSigningKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { exp: payload.exp, email: payload.email } : null;
  } catch {
    return null;
  }
}

// /login and /guest: the two Access-gated paths. The Access edge has already
// forced the interactive login and injected the JWT; relay it into a
// host-wide cookie and bounce back to the requested URL. Without the Access
// app in front, there is no JWT and this fails closed.
export function login(request: Request, url: URL): Promise<Response> {
  return relay(OWNER, request, url);
}

export function guest(request: Request, url: URL): Promise<Response> {
  return relay(GUEST, request, url);
}

async function relay(relay: Relay, request: Request, url: URL): Promise<Response> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response(
      `${relay.path} is not gated by a Cloudflare Access application; refusing\n`,
      { status: 503 },
    );
  }
  const payload = await verifyJwt(jwt, relay.aud());
  if (!payload) return new Response("forbidden\n", { status: 403 });

  // `to` must be a same-origin absolute path: "/x", not "//host", a URL, or
  // "/\\host", which browsers read as "//host". Resolving it against our
  // origin and comparing catches every spelling, so the public Guest Login
  // cannot be used as an open redirect.
  const to = url.searchParams.get("to") ?? "/";
  const dest = /^\//.test(to) && new URL(to, url.origin).origin === url.origin ? to : "/";
  const maxAge = Math.max(0, Math.floor(payload.exp - Date.now() / 1000));
  const separator = dest.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${dest}${separator}${relay.marker}=1`,
      "set-cookie": `${relay.cookie}=${jwt}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      "cache-control": "no-store",
    },
  });
}
