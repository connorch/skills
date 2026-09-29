---
name: claude-router
description: Use when Claude Code hits a rate limit, when asked which account is serving, or to bypass or force an account through claude-router.
metadata:
  machines: [connors-mac-studio, connors-macbook-pro]
  requires: "the claude-router service and CLI installed by a Ship"
---

# claude-router

A local proxy on `127.0.0.1:47880` routes every Claude Code inference request
across Connor's subscription accounts and fails over on limit errors. It is
wired in through `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`.

```sh
claude-router status          # accounts, bucket usage, ranking per model, pins
claude-direct [args]          # one Claude Code session straight at api.anthropic.com
claude-work [args]            # through the router, only the work account, no failover
                              # (one claude-<label> per account)
claude-router-off             # zero-dependency: take it out of settings.json and stop it
claude-router on              # put it back (shows the diff, asks)
claude-router accounts sync   # refresh tokens from 1Password after a 401
tail ~/.local/state/claude-router/requests.jsonl   # one line per request: account, attempts, reason
```

The `claude-<label>` commands set the header `x-claude-router-account: <label>`
through `ANTHROPIC_CUSTOM_HEADERS` in the environment. Do not pass it with
`--settings`: Claude Code keeps only the last `--settings` flag.
The desktop app is never routed. Never print tokens.
