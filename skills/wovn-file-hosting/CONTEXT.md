# Wovn File Hosting

Personal file host at files.wovn.org: one hostname, one R2 bucket, per-object
visibility that fails closed. Uploads come from the wovn CLI; reads come from
shared URLs, the CLI, and the browse UI.

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

## Relationships

- A **File** has exactly one **Key** and one effective **Visibility**
- A **Stable Path** accumulates **Versions**; a **Generated Key** never does
- A **Directory Route** exists implicitly for every prefix that contains
  **Files**; it is never public regardless of the Files' **Visibility**
- **Versions** are always private regardless of their File's **Visibility**

## Example dialogue

> **Dev:** "If a **File** at `pr-assets` exists and I GET `/pr-assets`, do I
> get the listing?"
> **Domain expert:** "No - an exact **Key** match always serves the **File**.
> The **Directory Route** for that prefix is still reachable at
> `/pr-assets/`."

## Flagged ambiguities

- "file" vs "doc" vs "object" were used interchangeably - resolved: **File**
  is canonical; code may keep R2's `object` where it mirrors the SDK.
