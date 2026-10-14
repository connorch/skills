# Context map

Where each bounded context in this repo keeps its domain language and design
records. Read the context's `CONTEXT.md` before changing its code, and add
new terms there rather than inventing them in code comments.

| Context                                                  | Code                                                 | Language                                                 | Decisions                                                      |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Agent skills (the skills and how they Ship to the Fleet) | `skills/`, `archived/`, `instructions/`, `apps/ship` | [`CONTEXT.md`](CONTEXT.md)                               | [`docs/adr/`](docs/adr/)                                       |
| claude-router (multi-account proxy for Claude Code)      | `apps/claude-router`                                 | [`CONTEXT.md`](apps/claude-router/CONTEXT.md)            | [`apps/claude-router/docs/adr/`](apps/claude-router/docs/adr/) |
| Bambu printing (the `bambu` CLI, the Review Page viewer) | `apps/bambu-cli`, `apps/bambu-viewer`                | [`apps/bambu-cli/CONTEXT.md`](apps/bambu-cli/CONTEXT.md) | [`apps/bambu-cli/docs/adr/`](apps/bambu-cli/docs/adr/)         |

The `wovn-file-hosting` skill under `skills/` is the agent-facing usage guide
for the `wovn` CLI, whose context lives in
[connorch/wovn](https://github.com/connorch/wovn). Likewise the
`bambu-print` skill is the usage guide for the Bambu printing context, and
`vendor/bambu-studio-ai` is the upstream Python reference it was ported from,
not a context.
