---
name: sb-ingest-superwhisper-meeting
description: Find superwhisper meeting recordings not yet in the second-brain Obsidian vault, convert their meta.json diarized segments into speaker-separated markdown transcripts, identify speakers by name using Google Calendar (gws CLI) and transcript evidence, and file the results into second-brain/Sources with vault-convention frontmatter. Use when the user asks to ingest, process, or transcribe superwhisper recordings or meeting transcripts into the second brain or Obsidian vault.
---

# Superwhisper Meeting Ingest

Pipeline: **discover -> transcribe -> identify speakers -> review with user -> file into vault**.
All scripts run with `bun`. Work in `/tmp/sb-ingest-superwhisper-meeting/`; only final files
touch the vault. Key paths, conventions, and evidence patterns: [REFERENCE.md](REFERENCE.md).

## 1. Discover unprocessed meetings

```sh
bun ~/.agents/skills/sb-ingest-superwhisper-meeting/scripts/find-unprocessed.ts
```

Lists recordings with >1 diarized speaker and >=2 min that no vault note's `source:`
frontmatter references. `--json` for machine output, `--all` to include already-ingested.
If nothing is new, report that and stop. Otherwise make the workdir:
`mkdir -p /tmp/sb-ingest-superwhisper-meeting`.

## 2. Pull calendar context

For the date range spanning the new recordings (recording `datetime` is **UTC**; local
start = UTC + the current UTC offset, and it can shift the calendar date):

```sh
bun ~/.agents/skills/sb-ingest-superwhisper-meeting/scripts/calendar-events.ts --from 2026-07-13 --to 2026-07-16
```

Match each recording's local start time (a few minutes' drift is normal) and duration to
an event. Ad-hoc calls legitimately have no event. If `gws` errors, continue without
calendar data - identify speakers from transcript evidence alone and say so.

## 3. Build the config, then identify speakers

Write `/tmp/sb-ingest-superwhisper-meeting/config.json` (full schema in REFERENCE.md), then
generate draft transcripts with raw speaker ids into the workdir:

```sh
cd /tmp/sb-ingest-superwhisper-meeting
bun ~/.agents/skills/sb-ingest-superwhisper-meeting/scripts/transcript-to-md.ts ~/Documents/superwhisper/recordings/<id>/meta.json -c config.json -o .
```

Read each draft and assign names only on transcript evidence, strongest first:
self-identification > direct address ("Tony, have you met Connor?" -> next voice answers) >
work/role ownership corroborated elsewhere. Calendar attendees constrain *who was present*,
never which diarization id is whom. Record every mapping in the config's `speakers` with a
`basis` quote and a `confidence` rating. **If evidence is thin, leave raw speaker ids** -
an unnamed speaker is fine; a misnamed one is not. Also scan drafts for a conversation that
ends mid-file (goodbyes, then "Hello?") - that is two recordings in one; split it with
`parts`, and mark non-meeting parts `"vault": false`.

## 4. Review with the user

Before touching the vault, show: each meeting's proposed vault name, date, matched calendar
event, speaker mapping with confidence and basis, any splits or exclusions, and any
recording left with raw ids. Wait for approval. Ask about anything surprising (a personal
call, an unknown voice) rather than guessing.

## 5. File into the vault

Add `vaultName` (`Meeting YYYY-MM-DD - Title`, **local** date) and `attendees` (everyone
except Connor) to each config entry, then regenerate with frontmatter directly into the
vault and clean up:

```sh
bun ~/.agents/skills/sb-ingest-superwhisper-meeting/scripts/transcript-to-md.ts <meta.json ...> -c config.json --frontmatter -o ~/Obsidian/second-brain/Sources
rm -rf /tmp/sb-ingest-superwhisper-meeting
```

Check name collisions in `Sources/` first; never overwrite an existing note. Files land
without `watcher: Ignore`, so the vault watcher ingests them (~2 min debounce). Finish by
listing the created files and per-file speaker confidence.
