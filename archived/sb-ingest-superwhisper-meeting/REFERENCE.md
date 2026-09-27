# Reference

## Paths

| What | Where |
|---|---|
| Recordings | `~/Documents/superwhisper/recordings/<unix-ts>/meta.json` (+ `output.wav`) |
| Vault sources | `~/Obsidian/second-brain/Sources/` |
| Vault rules | `~/Obsidian/second-brain/AGENTS.md` |
| Workdir | `/tmp/sb-ingest-superwhisper-meeting/` (create at start, delete when done) |

## meta.json essentials

- `datetime` - **UTC** despite no timezone suffix. Convert to local before matching
  calendar events or naming files; the local date can differ from the UTC date.
- `duration` - milliseconds.
- `segments[]` - `{text, start, end, speaker, confidence}`; start/end are seconds into
  the recording. `speaker` numbering is arbitrary per file (may start at 0 or 1) and is
  NOT stable across recordings.
- `result` / `rawResult` - flat transcript fallback when segments are missing.
- `separateSpeakersEnabled` / `systemAudioEnabled` - both true exactly when the recording
  was made in a call-recording mode; false together for dictation.
- Meeting heuristic: `separateSpeakersEnabled: true` AND >=2 min. The flag captures the
  intent to record a call, so it holds even when diarization only finds one voice; the
  duration floor drops mic tests and mode-setup experiments.
- `modeName` is NOT a usable signal. The mode named "Meeting" only ever held sub-minute
  setup tests, real calls are recorded under other mode names, and the names are
  user-editable.

## config.json schema (input to transcript-to-md.ts)

```jsonc
{
  "utcOffsetHours": -7,                      // current local offset (PDT -7, PST -8)
  "originalsRoot": "~/Documents/superwhisper/recordings",  // provenance paths
  "<meta.json basename without extension>": {
    "slug": "2026-07-13 1144 - Walton Standup",   // draft filename (no frontmatter mode)
    "event": "Walton - Stand Up, Jul 13 11:30 PDT (jake@, connor@)",  // or "no calendar event - ad-hoc call"
    "speakers": { "1": "Jake", "2": "Connor" },   // omit ids you cannot support
    "confidence": "high|medium|low|unresolved",
    "basis": "S1 says \"Steven, meet Connor, my cofounder\"",  // quote the evidence
    "vaultName": "Meeting 2026-07-13 - Walton Standup (Deploy Lifecycle)",
    "attendees": ["Jake Sendar"],                 // everyone except Connor
    "parts": [                                    // only for multi-conversation recordings
      { "slug": "...", "to": 1625, "speakers": {...}, "vaultName": "...", "attendees": [...] },
      { "slug": "...", "from": 1670, "vault": false }   // vault:false = never filed
    ]
  }
}
```

`transcript-to-md.ts` flags: `-c CONFIG`, `-o OUTDIR`, `--frontmatter` (vault mode:
frontmatter + `vaultName` filenames, skips `vault: false` parts), `--raw-speakers`
(disable diarization repair). Without `--frontmatter` it writes `<slug> - transcript.md`
drafts. The script also auto-repairs diarization: a turn starting lowercase after an
unfinished sentence is a continuation of the previous speaker (only the fragment up to
the first sentence end moves), and in 2-person calls stray <=3-word backchannels on a
phantom third id go to whichever named speaker is not holding the floor.

## Vault note format

Filename `Meeting YYYY-MM-DD - Title.md` (local date). Frontmatter emitted by
`--frontmatter`:

```yaml
---
type: source
title: "Walton Standup (Deploy Lifecycle)"
date: 2026-07-13
time: "11:44 (UTC-07:00)"
attendees: ["Jake Sendar"]
project: []
source: "~/Documents/superwhisper/recordings/1783968291/meta.json"
---
```

The `source:` path is the dedupe key `find-unprocessed.ts` scans for - every vault file
must carry it. No `watcher:` key means the vault watcher will ingest the note; adding
`watcher: Ignore` (the historical Notion imports have this) suppresses that. Ask the user
if unsure which they want. The vault is a git repo; do not commit - the user's automation
owns commits.

## Speaker identification evidence, strongest -> weakest

1. **Self-identification**: "I'm CTO, cofounder", "I'm an attorney and software engineer",
   "my cofounder, his name is Jake Sendar", "my wife is an ECVC lawyer".
2. **Direct address + response**: "Tony, have you met Connor?" -> the voice that answers
   "I have not" is Tony. Vocatives at turn end point at the *next* speaker.
3. **Work ownership across meetings**: who shipped/owns what, corroborated by another
   transcript or the calendar (e.g. "I shipped the workspace collaboration stuff").
4. Do NOT trust: stylometry/phrase frequency (tested, inconclusive), word-share, turn
   order, or calendar attendee order.

Calendar tells you the roster; only the transcript tells you which id is which person.
Diarization quirks to expect: interleaved names may be one person quoting another;
in >4-person calls, quiet attendees get absorbed into other ids (note this in `basis`);
5 ids does not mean 5 people.

## Known context (verify, don't assume)

Connor Chevli (user, connor@walton.ai) - CTO/cofounder of Walton, engineer, not a lawyer;
wife Kristin. Jake Sendar (jake@walton.ai) - cofounder/CEO, attorney + engineer; partner
Gabby. Recurring: "Walton - Stand Up" = Connor + Jake. External contacts seen before:
Mission Law (Tony, Jack, Alliah Bulala, JD Roldan), Goodwin (Thomas Rasmussen),
Anthropic (Mima), Uncork Capital (Belle Tangkuptanon).

## gws CLI notes

- Auth check: `gws calendar calendarList list`. A 403 naming a GCP project means the
  OAuth client's quota project doesn't authorize the logged-in account - the user must fix
  auth (`gcloud auth login`, then `gws auth setup` + `gws auth login`); don't retry around it.
- gws prints a stderr banner and `--format json` can reject valid requests; parse stdout
  from the first `{` (calendar-events.ts does this).
- Primary calendar id: `connor@walton.ai` (script default `primary` resolves to it).
