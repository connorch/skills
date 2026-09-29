# 1. Build claude-router instead of adopting better-ccflare

Date: 2026-09-28

## Status

Accepted

## Context

Connor holds three Claude subscriptions and wants every Claude Code client
(terminal, `claude -p`, t3code, OpenClaw) to draw on all of them without
choosing an account per thread. better-ccflare already does multi-account
proxying for Claude Code, with dashboards, combos, usage polling, and many
providers.

## Decision

Write our own proxy, about a thousand lines, in this repo, and use
better-ccflare only as a source of edge cases (bare 429s, 401 and 403
handling, `metadata.user_id` as the session key).

Policy choices that differ from better-ccflare:

- Bucket data comes only from response headers; no usage-endpoint polling.
- Blocking is per bucket, learned from headers, so a Fable-only `7d_oi`
  rejection does not block Sonnet on the same account.
- A forced account is strict: it answers for itself, limit errors included.
  better-ccflare's equivalent header silently falls back to normal selection.
- The desktop app is passed through by entrypoint; it manages its own auth.
- One `~/.claude` config dir for every client. Per-account config dirs drift
  (skills, plugins, memory, settings) and were retired.

## Consequences

- Ships with the Fleet like every other CLI here; no separate service to
  operate, no database, no dashboard.
- Anything better-ccflare learned that we did not copy has to be learned
  again when it bites. The request log is the main debugging tool.
- The router process is a single point of failure for routed clients.
  `KeepAlive` restarts it; `claude-router-off` removes it with no Node.
