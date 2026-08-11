# wovn-files

Cloudflare Worker behind `https://files.wovn.org`, the file host used by the
`file-upload` skill. Authenticated `PUT`/`POST` uploads write to the
`wovn-files` R2 bucket and return the permanent public URL; `GET` serves
stored objects. Deployed on the personal Cloudflare account
(connorchev@gmail.com), pinned via `account_id` in `wrangler.jsonc`.

## Develop and deploy

```sh
pnpm install
pnpm typecheck
pnpm run deploy
```

## The wovn CLI

`../bin/wovn` wraps the host for agents and humans: `wovn put <file...>`
uploads and prints URLs, `wovn rotate` rotates the token. It is installed by
copy: `cp ../bin/wovn ~/.local/bin/wovn` (re-run after editing the script).

## Token rotation

The upload token lives in two places: the `FILE_HOST_TOKEN` Worker secret
(server side) and `~/.config/wovn-files/token.txt` (client side, exported
into the shell env by `~/.zshenv`). `wovn rotate` updates both: it sets the
Worker secret first (via npx wrangler, pinned to the personal account), then
writes the token file. Open a new shell if anything relies on the stale
`FILE_HOST_TOKEN` env var; `wovn` itself reads the file and keeps working.
