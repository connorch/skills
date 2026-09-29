# claude-router

A local proxy that routes Claude Code inference across several subscription
accounts, failing over on limit errors before any byte reaches the client.

## Language

**Account**:
One Claude subscription the router can serve from, named by its label
(`personal`, `personal_2`, `work`). Its token lives in the login Keychain,
copied from 1Password by `accounts sync`; nothing else reads 1Password.
_Avoid_: profile, credential, login

**Bucket**:
One usage window Anthropic reports in `anthropic-ratelimit-unified-<bucket>-*`
response headers (`5h`, `7d`, `7d_oi`). Blocking is per Bucket: an Account is
blocked for a model only while a Bucket seen on that model's responses is
rejected. A model the Account has not served yet is judged by the Buckets
every seen model shares.
_Avoid_: quota, window, limit (as a noun)

**Session**:
One Claude Code conversation, keyed by `metadata.user_id` in the request body.

**Pin**:
The Account a Session sticks to, so its prompt cache stays warm. A Pin lapses
after an hour idle. Otherwise the Session's newest request decides it: the
Pin moves when that request is served by another Account (a Failover, the
pinned Account being held out, or a Forced Account). It never moves back just
because the old Account recovered.
_Avoid_: affinity, sticky session

**Failover**:
Resending the same request bytes to the next Account in rank after an error
that belongs to the Account, not the request: any 429, a 401, an org
permission block, or a 5xx or connection error that survived its one retry.
Invisible to the client.
_Avoid_: retry (that is the same Account, once, on a 5xx or a connection error)

**Passthrough**:
Forwarding a request unchanged with the client's own auth: non-inference
paths, the desktop app entrypoint, and fail-open when no tokens exist.

**Forced Account**:
The Account named by the `x-claude-router-account` request header. It serves
alone, limit errors included.

**Bench**:
A short, self-expiring hold on an Account after a transient upstream error
(a 5xx or connection error that survived its retry, or a stream upstream cut
short), an org permission block (with backoff and one probe at a time), or a
429 that carries only `retry-after`.

**Broken**:
An Account whose token returned 401. Held out until the next `accounts sync`.

## Relationships

- A **Session** has at most one **Pin**; the Session's newest request decides it, so a **Failover** moves it unless a newer request already set it
- An **Account** is blocked per model by its **Buckets**, held out entirely by a **Bench** or being **Broken**
- A **Forced Account** and a **Passthrough** never **Failover**

## Flagged ambiguities

- "rate limited" was used for both a rejected **Bucket** and a 429 with no
  rejected **Bucket** - resolved: the first blocks by **Bucket**, the second is
  request-scoped and holds nothing against the **Account** unless it carries
  `retry-after`, which is a **Bench**.
