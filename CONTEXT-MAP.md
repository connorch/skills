# Context map

Where each bounded context in this repo keeps its domain language and design
records. Read the context's `CONTEXT.md` before changing its code, and add
new terms there rather than inventing them in code comments.

| Context                                                    | Code                                                 | Language                                                   | Decisions                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Agent skills (the skills and how they Ship to the Fleet)   | `skills/`, `archived/`, `instructions/`, `apps/ship` | [`CONTEXT.md`](CONTEXT.md)                                 | [`docs/adr/`](docs/adr/)                                       |
| Wovn file hosting (files.wovn.org host and the `wovn` CLI) | `apps/wovn-files`, `apps/wovn-cli`                   | [`apps/wovn-files/CONTEXT.md`](apps/wovn-files/CONTEXT.md) | [`apps/wovn-files/docs/adr/`](apps/wovn-files/docs/adr/)       |
| claude-router (multi-account proxy for Claude Code)        | `apps/claude-router`                                 | [`CONTEXT.md`](apps/claude-router/CONTEXT.md)              | [`apps/claude-router/docs/adr/`](apps/claude-router/docs/adr/) |
| Bambu printing (the `bambu` CLI, the Review Page viewer)   | `apps/bambu-cli`, `apps/bambu-viewer`                | [`apps/bambu-cli/CONTEXT.md`](apps/bambu-cli/CONTEXT.md)   | [`apps/bambu-cli/docs/adr/`](apps/bambu-cli/docs/adr/)         |

The host owns the Wovn language: the CLI is a client of the host's API and
uses the same terms. The `wovn-file-hosting` skill under `skills/` is the
agent-facing usage guide for the CLI, not a context of its own. Likewise the
`bambu-print` skill is the usage guide for the Bambu printing context, and
`vendor/bambu-studio-ai` is the upstream Python reference it was ported from,
not a context.
