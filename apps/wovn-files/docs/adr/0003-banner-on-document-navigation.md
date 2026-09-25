---
status: accepted
---

# The Banner on Document Navigation, Raw everywhere else

Opening a File URL in a browser showed the stored bytes and nothing else: no
path, no Visibility, no way to reach the File's Versions or its directory
without editing the URL. We decided that every URL keeps serving exactly what
it serves today, with one exception: an authenticated Document Navigation
(`Sec-Fetch-Dest: document`, no `?raw` query) gets the File Page, the Banner
over the File. Anonymous readers, subresource loads (img, video, iframe),
downloads, fetch, curl, and `wovn read` all get Raw, so shared public URLs
stay byte-identical.

## One rule for Files and Directory Routes

The request's destination decides, not its `Accept` header. Directory Routes
drop the `Accept: text/html` check from ADR 0002 for the same rule, so there
is a single rule for the whole host: an authenticated Document Navigation
gets the app; everything else gets Raw, the existing 302 to `/login`, or the
existing 404. An authenticated non-browser client that sends
`Accept: text/html` now gets the 404 too. `?raw` is the escape hatch for
humans and the Banner's own raw link. Browsers that do not send
`Sec-Fetch-Dest` get Raw, which is what they get today.

## HTML Files stay the document; everything else is a Preview

An HTML File is streamed through HTMLRewriter with the Banner injected at the
top of `<body>` as declarative Shadow DOM: the server-rendered Banner markup
and the app stylesheet inside `<template shadowrootmode="open">`, plus one
module script that hydrates it. The File's own head, styles, scripts,
relative links, and fragment links keep normal browser behaviour, and every
link to another File lands on that File with its own Banner. We rejected
framing HTML Files in an iframe (breaks fragment links, find-in-page, print,
and the URL bar) and rendering them inside the app tree (the File's scripts
would run inside ours). We assume File scripts do not replace the page in
ways that conflict with the Banner; today every HTML File comes from the
html-communication skill.

Every other type renders as an app page: the Banner plus a Preview of
`/<key>?raw`. Images, video, and audio use native elements. PDF and SVG go
in an iframe. Text types (`text/*`, JSON, YAML) are fetched and rendered as
text in the page rather than framed, because browsers download rather than
display `text/markdown`, `text/csv`, and `application/yaml` in a frame;
above a size cap of 2 MB the text Preview gives way to the details-and-
download card so a large log is never pulled into the DOM. Types with no
browser rendering get the details-and-download card.

## Panel and Version state live in the query, not the path

`/<key>?versions` is the File Page with the versions panel open, and
`/<key>?version=<stamp>` is the File Page for that Version. ADR 0002 put
the Versions view at `/<key>/archive` and the Version itself at
`/<key>/archive/<stamp>`, but a document's base URL is its path, so an HTML
File served at `/docs/a.html/archive` would resolve its relative link
`other.html` to `/docs/a.html/other.html`, and a Version served under its
stamp has the same problem. Keeping the File's own path for both keeps
relative links, fragment links, and the File-as-document intact, and `?raw`
already made the query the app's control channel. A Document Navigation to
`/<key>/archive`, `/<key>/archive/<stamp>`, or the storage Key
`archive/<key>/<stamp>` 302s to the query form; every other request to those
URLs still gets Raw, so `wovn read`, `wovn history`, and `wovn diff` are
unchanged. The remaining Banner state (collapsed or open, active tab) is
client-only.

## No sandbox, no content origin

Uploaded HTML already runs on the authenticated origin today, so wrapping it
is not a regression. A CSP sandbox or a separate content origin would cost a
second hostname and a cross-origin Banner and buy no safety for the HTML we
actually host. Revisit if untrusted HTML ever lands in the bucket.

## Caching

One URL now has two representations, and the browser cache must not mix
them. App responses and injected HTML are `private, no-store`. Raw responses
add `Vary: Sec-Fetch-Dest, Cookie`; both are needed, because an anonymous
navigation to a public PNG caches immutable bytes and a later logged-in
navigation sends the same destination header. The Worker uses no edge cache,
so browser cache headers are the whole story.
