# claude-router

A local proxy that routes Claude Code inference across several subscription
accounts, failing over on limit errors before any byte reaches the client.

## Language

**Account**:
One Claude subscription the router can serve from, named by its label
(`personal`, `personal_2`, `work`). Its token lives in the login Keychain,
synced from 1Password.
_Avoid_: profile, credential, login

**Bucket**:
One usage window Anthropic reports in `anthropic-ratelimit-unified-<bucket>-*`
response headers (`5h`, `7d`, `7d_oi`). Blocking is per Bucket: an Account is
blocked for a model only while a Bucket seen on that model's responses is
rejected.
_Avoid_: quota, window, limit (as a noun)

**Session**:
One Claude Code conversation, keyed by `metadata.user_id` in the request body.

**Pin**:
The Account a Session sticks to, so its prompt cache stays warm. A Pin lapses
after an hour idle and moves only when a limit error forces it; it never
snaps back.
_Avoid_: affinity, sticky session

**Failover**:
Resending the same request bytes to the next Account in rank after a limit
error. Invisible to the client.
_Avoid_: retry (that is the same Account, once, on a 5xx)

**Passthrough**:
Forwarding a request unchanged with the client's own auth: non-inference
paths, the desktop app entrypoint, and fail-open when no tokens exist.

**Forced Account**:
The Account named by the `x-claude-router-account` request header. It serves
alone, limit errors included.

**Bench**:
A short, self-expiring hold on an Account after a transient upstream error,
an org permission block (with backoff and one probe at a time), or a bare
`retry-after`.

**Broken**:
An Account whose token returned 401. Held out until the next `accounts sync`.

## Relationships

- A **Session** has at most one **Pin**; a **Failover** moves the **Pin**
- An **Account** is blocked per model by its **Buckets**, held out entirely by a **Bench** or being **Broken**
- A **Forced Account** and a **Passthrough** never **Failover**

## Flagged ambiguities

- "rate limited" was used for both a rejected **Bucket** and a bare 429 with
  no bucket headers - resolved: the first blocks by **Bucket**, the second is
  request-scoped and holds nothing against the **Account**.
