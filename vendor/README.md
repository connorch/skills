# vendor

Upstream code kept for reference only. Nothing here is built, linted, tested,
or shipped; see `apps/bambu-cli/docs/adr/0001-typescript-port-of-bambu-studio-ai.md`.

## bambu-studio-ai

[heyixuan2/bambu-studio-ai](https://github.com/heyixuan2/bambu-studio-ai), the
Python agent skill the `bambu` CLI's model-preparation features are ported from.
A plain copy of upstream's tree (no `git subtree`, no submodule: we never edit
it, so upstream's history is not needed, and a copy keeps branches rebasable).
Its tests and fixtures are the port's spec.

Tracked upstream commit: `cdc2698` (2026-09-20).

To see what upstream changed since then, replace the copy and read the diff:

```sh
git clone --depth 1 https://github.com/heyixuan2/bambu-studio-ai /tmp/bambu-studio-ai
git -C /tmp/bambu-studio-ai rev-parse --short HEAD
rm -rf vendor/bambu-studio-ai && cp -R /tmp/bambu-studio-ai vendor/bambu-studio-ai && rm -rf vendor/bambu-studio-ai/.git
git diff --stat
```

Then update the commit above. Delete this folder when we stop tracking upstream.
