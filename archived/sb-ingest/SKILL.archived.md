---
name: sb-ingest
description: File any content the user provides (a pasted conversation, email, notes, article, transcript, or a file path) verbatim into the second-brain Obsidian vault's Sources directory so the vault automation ingests it. Use when the user invokes /sb-ingest or asks to put, drop, or add something into Sources or the second brain.
---

# Second Brain Ingest

Take whatever the user provided - pasted text, or a file path to read - and file it as
one markdown note in `~/Obsidian/second-brain/Sources/`. That directory holds raw,
Connor-owned material: deposit the content **verbatim**. Never summarize, rewrite, or add
agent-authored prose. Stripping obvious copy-paste chrome (UI labels like "View Kevin's
profile", duplicated reaction rows, timestamps repeated by the app) is fine; changing the
actual words is not. The downstream vault ingest agent does the summarizing, not you.

## Steps

1. **Identify the content.** Everything after the command is the source. If the user gave
   a file path instead of text, read that file and use its contents. One invocation = one
   note, unless the user clearly provides multiple separate sources.
2. **Name the file.** Short, descriptive, Title Case: `<What It Is>.md`, e.g.
   `Kevin Krom LinkedIn DM - Inngest Native Ingest.md`. Check `Sources/` for collisions
   first; never overwrite an existing note - pick a different name instead.
3. **Write the note**: vault-convention frontmatter, then the verbatim content.

   ```yaml
   ---
   type: source
   title: "Kevin Krom LinkedIn DM - Inngest Native Ingest"
   date: 2026-08-11
   ---
   ```

   `date` is when the content happened - infer it from the content ("Today", message
   timestamps, email headers); fall back to today's date. Do **not** add a `watcher:`
   key: its absence is what lets the vault watcher pick the note up for ingestion
   (~2 min debounce). Add `watcher: ignore` only if the user says they don't want it
   ingested.

4. **Hands off everything else.** The vault is a git repo owned by Connor's automation:
   do not commit, and do not touch `Wiki/`, `Daily/`, or any other file. Your only write
   is the new note in `Sources/`.
5. **Report** the created file path and note that the watcher will ingest it shortly.
