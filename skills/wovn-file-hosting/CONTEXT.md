# Wovn File Hosting

Personal file host at files.wovn.org: one hostname, one R2 bucket, per-object
visibility that fails closed. Uploads come from the wovn CLI; reads come from
shared URLs, the CLI, and the browser, where a logged-in Document Navigation
gets the Banner around the File.

## Language

**File**:
A stored object in the bucket, addressed by its Key.
_Avoid_: doc, object, upload (as a noun)

**Key**:
The full path that identifies a File, e.g. `pr-assets/shot.png`.
_Avoid_: path (alone), name

**Generated Key**:
A collision-proof immutable Key minted by POST (`yyyy/mm/<random>-<name>`).

**Stable Path**:
A Key the client chose explicitly (PUT), safe to re-publish in place; forced
overwrites archive the previous Version.

**Visibility**:
A per-File stamp, `public` or `private`; absent means private (fail closed).

**Version**:
A previous state of a Stable Path, stored under `archive/` when an overwrite
forces it out.

**Directory Route**:
A URL path with no exactly matching File; it renders the browse UI listing
the Files under that prefix. A trailing slash always means a Directory Route.
_Avoid_: folder route, listing page

**Reserved Key**:
A name uploads may never claim because a system route owns it; the worker
rejects it with a message naming the reserved word. All Reserved Keys are
top-level, except `archive`, which is reserved in any Key segment.
_Avoid_: blacklist, blocked path

### Serving

**Raw**:
A response that serves a File's stored bytes and headers unchanged; `?raw`
forces it.
_Avoid_: direct, bytes, download

**Document Navigation**:
A browser request that will render the response as its top-level page, and
the only kind of request that ever gets a Banner.
_Avoid_: page load, browser request

**Banner**:
The app strip and its expandable panel that Wovn places above a File's
content for a logged-in reader.
_Avoid_: wrapper, overlay, toolbar, chrome

**File Page**:
What an authenticated Document Navigation to a File shows: the Banner over
the File.
_Avoid_: file view, wrapped file

**Preview**:
The rendering of a non-HTML File inside its File Page.
_Avoid_: viewer, embed

## Relationships

- A **File** has exactly one **Key** and one effective **Visibility**
- A **Stable Path** accumulates **Versions**; a **Generated Key** never does
- A **Directory Route** exists implicitly for every prefix that contains
  **Files**; it is never public regardless of the Files' **Visibility**
- **Versions** are always private regardless of their File's **Visibility**
- A **File Page** exists only for a **Document Navigation** that is
  authenticated; every other request to a **File** gets **Raw**
- An HTML **File** is its own **File Page** body (the **Banner** is injected
  into it); every other **File** gets a **Preview** of its **Raw** response
- A **Version** has a **File Page** too; its **Banner** names the Version and
  links to the current **File**

## Example dialogue

> **Dev:** "If a **File** at `pr-assets` exists and I GET `/pr-assets`, do I
> get the listing?"
> **Domain expert:** "No - an exact **Key** match always serves the **File**.
> The **Directory Route** for that prefix is still reachable at
> `/pr-assets/`."

> **Dev:** "If I open a public PNG while logged in, do I get the **Banner**?"
> **Domain expert:** "Yes - that is a **Document Navigation**, so you get the
> **File Page** with a **Preview** of the PNG. An `<img>` on another page,
> curl, `wovn read`, and anyone not logged in get **Raw**, byte-identical to
> today. Add `?raw` if you want the same in your own browser."

## Flagged ambiguities

- "file" vs "doc" vs "object" were used interchangeably - resolved: **File**
  is canonical; code may keep R2's `object` where it mirrors the SDK.
- "wrapper", "overlay", and "banner" were used for the same surface -
  resolved: **Banner** is the surface; "injected" describes how it reaches an
  HTML File and is not a term.
