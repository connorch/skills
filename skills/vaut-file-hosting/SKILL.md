---
name: vaut-file-hosting
description: Use whenever the user provides a link to files.vaut.dev, when a local file needs a public or private URL, or when the user asks to upload, host, share, list, or retrieve files through Vaut.
metadata:
  requires: "the vaut CLI on PATH, signed in with vaut login"
---

# Vaut file hosting

Upload files to `https://files.vaut.dev` and return the permanent URL from the
response body. Files are **private by default** - only Connor can open them
(signed in to vaut.dev in the browser, or through the CLI). Pass `--public` only when the URL must be
readable by others (PR screenshots, images embedded on GitHub, anything
shared externally). Prefer the `vaut` CLI:

```sh
vaut put /path/to/plan.html                     # private (default)
vaut put --public pr-142-upload-flow-after.png  # public, for sharing
vaut put --public --name pr-142-after.png "/tmp/Screenshot 2026-08-11 at 3.14.15 PM.png"
```

The CLI is `@vaut/cli` and signs in once per machine through the browser:

```sh
npm i -g @vaut/cli
vaut login   # opens vaut.dev to confirm a code; saves a Token in ~/.config/vaut/config.json
```

On a machine without a browser, `vaut login --token <token> --host files.vaut.dev`
takes a Token minted in vaut.dev's settings. If the CLI is missing or not
signed in and neither works, tell the user instead of guessing.

The response body is the URL, nothing else. Generated keys are dated plus a
random slug, so uploading never overwrites anything, URLs never change, and a
URL is never reused; files exist until explicitly deleted with `vaut rm`.
Content types are inferred from the file extension, so images and videos
render inline in browsers.

## Public vs private

Every file carries its own visibility (public, private, or shared with
specific emails - see below); there is one host and one URL per file, and
flipping visibility never changes the URL. A private URL opened in
a browser bounces through vaut.dev's login; other people cannot open it -
never embed a private URL in a public PR or issue.

```sh
vaut visibility get docs/q3-roadmap.html         # public | private
vaut visibility set docs/q3-roadmap.html public  # publish; URL unchanged
vaut visibility set docs/q3-roadmap.html private # unpublish (best effort:
                                                 # caches/readers may have seen it)
```

Reading a private file back (for example a previously uploaded plan):
`vaut read <url-or-path>`; bare paths like `docs/plan.html` work everywhere a
URL does.

## Sharing with specific people

`vaut share` opens a private file to a list of emails without making it
public. Guests open the normal URL, land on vaut.dev's guest login, enter
their email and the one-time code Vaut emails them; they get the file's bytes
and nothing else (no listing, no history). The URL never changes, so share the
file's own URL.

```sh
vaut share docs/q3-roadmap.html --email sam@acme.com --email lee@acme.com
vaut share docs/q3-roadmap.html -e sam@acme.com,lee@acme.com --expires 7d  # 12h, 2w, a date, or never
vaut share docs/q3-roadmap.html                  # print who it is shared with
vaut visibility set docs/q3-roadmap.html private # stop sharing
```

`--email` replaces the whole list each time; without `--expires` the current
expiry is kept (a new share never expires). Anyone who opens a shared URL
can tell a file exists there, so share links deliberately. Updating a shared
stable path with `--force` keeps it shared.

## Stable URLs

`vaut put --at <remote-path> <file>` writes to that exact path instead of a
generated key - the URL never changes. If the path is already taken the upload
is rejected; pass `--force` to replace it in place. Use it for living
documents (plans, reports, mocks) that get updated across iterations; use
plain `vaut put` for everything else. Updating a published document keeps it
public - visibility belongs to the path and only changes via
`vaut visibility set` or an explicit `--public`/`--private` on the upload.

```sh
vaut put --at docs/q3-roadmap.html /tmp/q3-roadmap.html
vaut put --at docs/q3-roadmap.html --force /tmp/q3-roadmap.html  # update in place
```

## Version history

Overwriting a stable path never destroys anything: the worker first copies
the old version to `archive/<path>/<timestamp>`, a permanent URL of its own.
Archived versions are **always private**, even for public documents; the
`archive/` prefix is reserved (`--at` cannot write there) and hidden from
`vaut list` - only per-path history shows it.

`vaut history <path-or-url>` prints every version of a stable path, newest
first, with the current one marked. `vaut diff` fetches two versions and runs
`git diff` on them; with a single argument it compares a stable path's
previous version against its current one - "what changed in the last
update?".

```sh
vaut history docs/q3-roadmap.html
vaut diff docs/q3-roadmap.html                  # previous vs current
vaut diff <old-url-or-path> <new-url-or-path>   # any two versions
```

## Deleting

`vaut rm <path-or-url>` deletes a file permanently - and for a stable path,
its entire archived history too, so nothing lingers. Passing a specific
archive URL prunes just that version. It prints every key it deleted.

```sh
vaut rm docs/old-plan.html
```

## Listing recent files

`vaut list` prints recent uploads, newest first, one line per file
(timestamp, size, `pub`/`shr`/`prv`, URL). `--public` / `--shared` /
`--private` filter by visibility; `-n <count>` changes the limit (default 20). Listing is
authenticated - public URLs are unguessable, so the listing itself is never
open.

```sh
vaut list
vaut list --private -n 50
```

## Filtering by git context

Every `vaut put` automatically tags the upload with the environment it ran
in: the working directory, and (when inside a git repo) the branch, the
worktree root, and the project - the main checkout the worktree was created
off of. Nothing needs to be passed at upload time.

`vaut list` filters on those tags with `--project`, `--branch`, `--worktree`,
and `--dir`. Each takes an optional value; a bare flag means "the current
one", inferred the same way uploads are tagged:

```sh
vaut list --branch                    # uploads made from the branch I'm on now
vaut list --project                   # uploads from this project, any worktree/branch
vaut list --project skills            # by project name (or full path)
vaut list --branch main --private     # explicit values combine with other flags
```

`--project` matches the project name or its full path; `--worktree` and
`--dir` match exact paths. Files uploaded before tagging existed, or via the
curl fallback, carry no context and never match a filter.

## Filtering by file type

`vaut list --type` narrows the listing to a file type, matched on the
extension in the URL. Values are either a category - `image`, `video`,
`document`, `data`, `archive` - or a bare extension, and can be
comma-separated or repeated:

```sh
vaut list --type image                 # png, jpg, jpeg, gif, webp, svg
vaut list --type document              # pdf, doc, docx, odt, rtf, md, html, txt, log
vaut list --type pdf,png               # exact extensions
vaut list --type image --private -n 50
```

The filter runs before the limit, so `--type pdf -n 20` means the 20 newest
PDFs rather than the PDFs among the 20 newest files. Files whose URL has no
extension never match.

## File naming

The filename survives into the permanent URL, so rename files before
uploading: lowercase kebab-case, describe the content and its context, keep
the real extension. Characters outside `a-z A-Z 0-9 . _ -` are replaced with
`-` server-side.

- `pr-142-upload-flow-after.png`, not `Screenshot 2026-08-11 at 3.14.15 PM.png`
- `ci-typecheck-failure.log`, not `output.log`

## Embedding on GitHub

- Only `--public` URLs work for other people. Images: `![description](url)`
  renders inline in PRs, issues, and comments.
- Videos: GitHub only plays videos uploaded to its own CDN. Post externally
  hosted videos as a plain link, or convert short clips to GIF first if
  inline playback matters.

## In the browser

A File opened in a logged-in browser renders inside a Vaut wrapper (path,
visibility, versions) around the content, so it does not look like the bytes
`vaut read` returns. Public URLs and every non-browser reader get the exact
bytes; append `?raw` to see them in a browser. `vaut open <url-or-path>`
opens a File in the browser from the terminal.

## Where it runs

files.vaut.dev is the `files` Org on vaut.dev, Connor's own R2 bucket served
by Vaut (the connorch/vaut repo). This skill is for using the CLI; changing
the host is a separate job. fleetfizz ships the repo to every machine as a
Tracked Repo; its `pnpm ship:machine` installs the same CLI
`npm i -g @vaut/cli` does, and `vaut login` is still a per-machine step.
