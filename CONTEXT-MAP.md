# Context map

Where each bounded context in this repo keeps its domain language and design
records. Read the context's `CONTEXT.md` before changing its code, and add
new terms there rather than inventing them in code comments.

| Context                                                    | Code                               | Language                                                   | Decisions                                                |
| ---------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Wovn file hosting (files.wovn.org host and the `wovn` CLI) | `apps/wovn-files`, `apps/wovn-cli` | [`apps/wovn-files/CONTEXT.md`](apps/wovn-files/CONTEXT.md) | [`apps/wovn-files/docs/adr/`](apps/wovn-files/docs/adr/) |

The host owns the Wovn language: the CLI is a client of the host's API and
uses the same terms. The `wovn-file-hosting` skill under `skills/` is the
agent-facing usage guide for the CLI, not a context of its own.
