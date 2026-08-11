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

## Token rotation

The upload token lives in two places: the `FILE_HOST_TOKEN` Worker secret
(server side) and `~/.config/wovn-files/token.txt` (client side, exported
into the shell env by `~/.zshenv`). Rotate both in one line from this
directory:

```sh
openssl rand -hex 32 | tee ~/.config/wovn-files/token.txt | wrangler secret put FILE_HOST_TOKEN
```

Open a new shell (or `source ~/.zshenv`) to pick up the new value.
