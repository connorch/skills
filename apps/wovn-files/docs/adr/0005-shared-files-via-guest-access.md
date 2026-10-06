# Shared Files: a third Visibility gated by a Guest Access app

A File was either public (anyone with the URL) or private (only Connor).
Handing a sensitive document to two or three named people meant making it
public. We added a third Visibility, **shared**: a File carries a Share - a
list of emails and an optional expiry - and is Raw-readable by any Guest who
proves one of those emails. Everything else about the File is unchanged: same
Key, same URL, Versions stay private, Directory Routes stay private.

## Guests prove an email through Cloudflare Access, not through Wovn

Wovn sends no email and stores no codes. A second Access application, "wovn
guest", is path-scoped to `files.wovn.org/guest`, allows only the One-time
PIN login method, and has a single Allow policy that includes everyone. A
Guest who opens a shared URL without a Guest cookie is 302d to `/guest?to=`;
Access asks for an email, emails a code, and injects a JWT whose `email`
claim is the proven address; the Worker relays that JWT into a `wovn_guest`
cookie exactly as `/login` relays Connor's into `wovn_auth`, bounces back,
and from then on compares the cookie's email against each File's Share.

The two apps have different audiences. `isAuthenticated()` verifies only
`ACCESS_AUD`; `guestEmail()` verifies only `GUEST_AUD`. A Guest JWT can never
be mistaken for Connor's, however it is presented, and Connor's never names a
Guest. Both verifications run in the Worker (signature, issuer, audience,
expiry), so a deleted or misconfigured app fails closed.

Alternatives considered: a password gate (no identity, no revocation per
person, and a second mechanism to maintain) and our own one-time code flow
(an email provider, a code store, and rate limiting, for something Access
already does). Access costs one Zero Trust seat per unique Guest; the free
plan allows 50, enough for a personal host.

## A shared URL reveals that a File exists

ADR 0001's rule that private and nonexistent paths are indistinguishable
still holds for private Files. A shared File is different by design: the
point of sharing is that someone without a Wovn login can open the URL, so
anyone who opens it is sent to prove an email and learns that a shared File
sits there. The content stays protected; a Guest whose email is not on the
Share gets a 403 naming that email, with Access's sign-out as the only way
to try another (the Access session would otherwise hand back the same
email). We accept this for URLs that are handed out on purpose.

## The Share is metadata, like Visibility

`shareEmails` (comma-joined, lowercased, at most 20 - customMetadata is
capped at 2 KB) and `shareExpires` (ISO, absent = never) sit beside the
`visibility` stamp. The effective Visibility is public if stamped public,
else shared while the Share has not expired, else private. An expired Share
is kept on the File so the owner sees "share expired" and renews from the
old list in one step. Flipping to public or private drops the Share. A forced
overwrite of a Stable Path carries the Share forward with the Visibility -
updating a shared document does not withdraw it.

## Consequences

- Guests only ever get Raw: no Banner, no app, `private, no-store`, whatever
  the request destination. Relative subresources of a shared HTML File are
  not covered unless they are shared too; sharing is per File.
- `guest` joins the Reserved Keys.
- The Banner's visibility select gains `shared`, which opens a share form;
  `wovn share <path> --email ... --expires 7d` does the same from the CLI;
  `wovn visibility set <path> private` revokes.
- A Guest's session lasts 7 days (the app's session duration); revoking a
  Share takes effect on the next request regardless, since the Worker checks
  the Share itself.
