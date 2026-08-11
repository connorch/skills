#!/usr/bin/env bun
/**
 * List superwhisper recordings that look like meetings and are not yet in the vault.
 *
 * Usage:
 *   ./find-unprocessed.ts [--recordings DIR] [--sources DIR] [--min-minutes N] [--all] [--json]
 *
 * A recording is a meeting candidate when its diarization found more than one
 * speaker and it ran longer than --min-minutes (default 2). That combination
 * excludes dictation (single speaker) and mic tests (short), which is what the
 * archive is mostly made of.
 *
 * "Already ingested" is decided by the `source:` frontmatter of the vault notes,
 * which points at the recording's meta.json. The recording id is the directory
 * name, so the match is exact - no title or content guessing.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_RECORDINGS = join(homedir(), "Documents/superwhisper/recordings");
const DEFAULT_SOURCES = join(homedir(), "Obsidian/second-brain/Sources");
const RECORDING_ID = /recordings\/(\d+)\/meta\.json/;

interface Segment {
  text?: string;
  speaker?: number | null;
}

interface Meta {
  segments?: Segment[];
  result?: string;
  rawResult?: string;
  datetime?: string;
  duration?: number;
  modeName?: string;
  modelName?: string;
  systemAudioEnabled?: boolean;
}

export interface Candidate {
  id: string;
  path: string;
  startedUtc: string;
  startedLocal: string;
  minutes: number;
  speakers: number;
  words: number;
  model: string;
  ingested: boolean;
  ingestedAs?: string[];
}

/** UTC wall-clock from meta.json rendered in the machine's local zone. */
export function toLocal(datetimeUtc: string | undefined): string {
  if (!datetimeUtc) return "";
  const utc = new Date(`${datetimeUtc}Z`);
  if (Number.isNaN(utc.getTime())) return "";
  return utc.toLocaleString("sv-SE").slice(0, 16);
}

async function readMeta(path: string): Promise<Meta | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Meta;
  } catch {
    return undefined;
  }
}

/** Recording ids already referenced by a vault note's `source:` frontmatter. */
async function ingestedIds(sourcesDir: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let files: string[] = [];
  try {
    files = (await readdir(sourcesDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return found;
  }

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(sourcesDir, file), "utf8");
    } catch {
      continue;
    }
    if (!text.startsWith("---")) continue;
    const end = text.indexOf("\n---", 3);
    const frontmatter = end < 0 ? text.slice(0, 2000) : text.slice(0, end);
    for (const match of frontmatter.matchAll(new RegExp(RECORDING_ID, "g"))) {
      const id = match[1]!;
      found.set(id, [...(found.get(id) ?? []), file]);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const recordingsDir = flag("--recordings", DEFAULT_RECORDINGS);
  const sourcesDir = flag("--sources", DEFAULT_SOURCES);
  const minMinutes = Number(flag("--min-minutes", "2"));
  const showAll = argv.includes("--all");
  const asJson = argv.includes("--json");

  const ingested = await ingestedIds(sourcesDir);
  const entries = (await readdir(recordingsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const candidates: Candidate[] = [];
  for (const id of entries) {
    const path = join(recordingsDir, id, "meta.json");
    const meta = await readMeta(path);
    if (!meta) continue;

    const segments = (meta.segments ?? []).filter((s) => (s.text ?? "").trim());
    const speakers = new Set(
      segments.map((s) => s.speaker).filter((s): s is number => s !== null && s !== undefined),
    );
    const minutes = (meta.duration ?? 0) / 60000;
    if (speakers.size <= 1 || minutes < minMinutes) continue;

    const hits = ingested.get(id);
    candidates.push({
      id,
      path,
      startedUtc: meta.datetime ?? "",
      startedLocal: toLocal(meta.datetime),
      minutes: Number(minutes.toFixed(1)),
      speakers: speakers.size,
      words: (meta.result ?? meta.rawResult ?? "").split(/\s+/).filter(Boolean).length,
      model: meta.modelName ?? "",
      ingested: Boolean(hits),
      ...(hits ? { ingestedAs: hits } : {}),
    });
  }

  const shown = showAll ? candidates : candidates.filter((c) => !c.ingested);

  if (asJson) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  console.log(
    `${candidates.length} meeting candidate(s) in ${recordingsDir}; ` +
      `${candidates.filter((c) => c.ingested).length} already in the vault.`,
  );
  if (shown.length === 0) {
    console.log("Nothing to ingest.");
    return;
  }
  console.log(`\n${showAll ? "All candidates" : "Not yet ingested"}:`);
  for (const c of shown) {
    const mark = c.ingested ? "[done]" : "[ new]";
    console.log(
      `  ${mark} ${c.id}  ${c.startedLocal} local  ${String(c.minutes).padStart(5)}min  ` +
        `${c.speakers} spk  ${c.words}w`,
    );
    if (c.ingestedAs) console.log(`          -> ${c.ingestedAs.join(", ")}`);
  }
}

await main();
