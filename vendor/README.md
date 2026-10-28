# vendor

Upstream code kept for reference only. Nothing here is built, linted, tested,
or shipped. Each folder is a plain copy of upstream's tree (no `git subtree`, no
submodule: we never edit it, so upstream's history is not needed, and a copy
keeps branches rebasable).

## bambu-studio-ai

[heyixuan2/bambu-studio-ai](https://github.com/heyixuan2/bambu-studio-ai), the
Python agent skill the `bambu` CLI's model-preparation features are ported from
(see `apps/bambu-cli/docs/adr/0001-typescript-port-of-bambu-studio-ai.md`).
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

## tstack

[t3dotgg/tstack](https://github.com/t3dotgg/tstack), Theo Browne's PR-lifecycle
skills (`sol-loop`, `full-send`, `full-stop`, `council`, and the ones they call),
as shown in his video "These 3 skills changed my life". MIT; see
`tstack/LICENSE`. `babysit-pr`, `file-pr`, `full-send`, `full-stop`,
`leaving-pr-comments`, `modernize`, and `sol-loop` were copied into `skills/`
from this commit, with skill references rewritten to `$skill` and `requires`
metadata added. `babysit-pr` also keeps the old version's `$file-pr` and
`$vaut-file-hosting` pointers, and its `pr-wait` gates on Codex and
CodeRabbit reviews too.
`council` and `takeover` are not used.

Tracked upstream commit: `7de017b` (2026-10-24).

To see what upstream changed since then, and port it to `skills/`:

```sh
git clone --depth 1 https://github.com/t3dotgg/tstack /tmp/tstack
git -C /tmp/tstack rev-parse --short HEAD
rm -rf vendor/tstack && cp -R /tmp/tstack vendor/tstack && rm -rf vendor/tstack/.git
git diff --stat
```

Then update the commit above.
