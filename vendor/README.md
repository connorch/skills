# vendor

Upstream code kept for reference only. Nothing here is built, linted, tested,
or shipped; see `apps/bambu-cli/docs/adr/0001-typescript-port-of-bambu-studio-ai.md`.

## bambu-studio-ai

[heyixuan2/bambu-studio-ai](https://github.com/heyixuan2/bambu-studio-ai), the
Python agent skill the `bambu` CLI's model-preparation features are ported from.
Added as a squashed `git subtree`; its tests and fixtures are the port's spec.

Tracked upstream commit: `cdc2698` (2026-09-20).

To see what upstream changed since then, pull and read the one squashed commit
the pull produces:

```sh
git subtree pull --prefix vendor/bambu-studio-ai https://github.com/heyixuan2/bambu-studio-ai main --squash
git show --stat HEAD^2
```

Then update the commit above. Delete this folder when we stop tracking upstream.
