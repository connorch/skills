# claude-router

Routes Claude Code inference across Connor's subscription accounts. See
[`CONTEXT.md`](CONTEXT.md) for the language, [`docs/adr/`](docs/adr/) for
decisions, and `skills/claude-router/SKILL.md` for the agent-facing guide.
The full plan is at https://files.wovn.org/docs/claude-router-plan.html
(private).

```sh
pnpm ship:machine                         # installs the CLI, wrappers, and LaunchAgent
claude-router accounts import-openclaw    # once: OpenClaw tokens -> 1Password
claude-router accounts sync               # 1Password -> Keychain, reload service
claude-router on                          # shows the settings.json diff, asks
claude-router status
claude-router off                         # or claude-router-off when Node is broken
```

Config is optional at `~/.config/claude-router/config.json` (see
`src/config.ts` for keys and defaults). State and the request log live under
`~/.local/state/claude-router/`.
