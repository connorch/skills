# Single host, one bucket, fail-closed per-object visibility

Wovn originally ran two hostnames over two R2 buckets: files.wovn.org (public,
`wovn-files`) and private.wovn.org (Cloudflare Access-gated, `wovn-private`).
Changing a file's visibility meant moving it between buckets, which broke URLs
and forked update history. We decided to serve everything from files.wovn.org
over the single `wovn-files` bucket, with visibility stored per object in R2
customMetadata: an object is public only when explicitly stamped
`visibility: public`; absent metadata means private (fail closed), and
`archive/` objects are always private regardless of stamping. private.wovn.org
and the `wovn-private` bucket are decommissioned entirely, with no redirects.

## Auth: Access JWT relayed via cookie, not a gated hostname

Cloudflare Access gates hostnames/paths before the Worker runs, so it cannot
make per-object decisions that depend on R2 metadata. Instead of gating a whole
hostname (breaks public sharing) or rolling our own identity (needless), the
Access app is scoped to the single path `files.wovn.org/login`. The Worker
302s unauthenticated requests for non-public objects to `/login?to=<path>`;
Access performs the interactive login there and injects its JWT; the Worker's
login handler copies that JWT into a host-wide cookie and 302s back; every
other route verifies the cookie with the same JWT-verification code (signature,
issuer, AUD, expiry) used previously. Cloudflare remains the only identity
provider and signer - the Worker only relays and verifies. Private and
nonexistent objects are indistinguishable to anonymous clients (both redirect
to `/login`), so probing leaks nothing.

## Consequences

- One credential: the bearer token (WOVN_TOKEN, formerly FILE_HOST_TOKEN) is
  fully authenticated on every route; the Access service token (`access.env`)
  is retired. The two secrets lived side by side on the same machines, so the
  old split bought no real compartmentalization.
- Visibility flips are metadata self-copies - same key, same URL, no move, and
  updates propagate because there is only one object.
- Reserved key list (uploads rejected): `archive/`, `login`, plus any future
  system routes. Kept as an explicit list rather than a prefix convention by
  deliberate choice.
- Any authenticated-only feature (file-browser UI, overlays) can be added on
  this hostname by checking the same cookie/token; the host-wide cookie was a
  motivating reason to consolidate to one hostname.
