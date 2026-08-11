#!/usr/bin/env bun
/**
 * Convert superwhisper meta.json recordings into speaker-separated markdown.
 *
 * Usage:
 *   ./transcript-to-md.ts FILE.json [FILE.json ...] [-c CONFIG] [-o OUTDIR] [--raw-speakers]
 *
 * Word-level `segments` are grouped into turns by consecutive `speaker` id.
 * A config file (see transcripts.config.json) supplies real speaker names,
 * calendar context, and optional time ranges for splitting one recording that
 * contains more than one conversation.
 *
 * Diarization repair: Deepgram capitalises the first word of a sentence, so a
 * turn that begins with a lowercase word is a continuation of the previous
 * speaker's unfinished sentence, not a real speaker change. Those leading
 * fragments are reassigned. Genuine interjections ("Yeah.", "Much cheaper.")
 * are capitalised and left alone. Disable with --raw-speakers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/** A long silence inside one speaker's turn starts a new paragraph. */
const PARAGRAPH_GAP_S = 10;
/** Trailing sentence-final punctuation, optionally followed by a closing quote/bracket. */
const SENTENCE_END = /[.!?]["')\]]?$/;
const STARTS_LOWERCASE = /^[a-z]/;

interface Segment {
  text?: string;
  start?: number;
  end?: number;
  speaker?: number | null;
  confidence?: number;
}

interface Meta {
  segments?: Segment[];
  result?: string;
  rawResult?: string;
  datetime?: string;
  duration?: number;
  modeName?: string;
  modelName?: string;
  promptContext?: { applicationContext?: { name?: string } };
}

interface PartConfig {
  slug?: string;
  from?: number;
  to?: number;
  event?: string;
  speakers?: Record<string, string>;
  confidence?: string;
  basis?: string;
  /** Obsidian vault filename (without extension), used with --frontmatter. */
  vaultName?: string;
  /** Everyone on the call except Connor, matching the vault's existing convention. */
  attendees?: string[];
  /** Set false to skip this part when writing to the vault. */
  vault?: boolean;
}

interface FileConfig extends PartConfig {
  parts?: PartConfig[];
}

interface Config {
  utcOffsetHours?: number;
  /** Where the untouched superwhisper recordings live, for `source:` provenance. */
  originalsRoot?: string;
  [key: string]: FileConfig | number | string | string[] | undefined;
}

/**
 * Path to the recording this transcript came from. Config keys end in the
 * superwhisper recording id, which is also its directory name.
 */
function originalMetaPath(key: string, originalsRoot: string | undefined): string | undefined {
  const id = key.match(/(\d+)$/)?.[1];
  if (!id || !originalsRoot) return undefined;
  return `${originalsRoot.replace(/\/$/, "")}/${id}/meta.json`;
}

interface Turn {
  speaker: number | null;
  start: number;
  lastEnd: number;
  paragraphs: string[][];
  indices: number[];
}

function timestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function joinWords(words: string[]): string {
  return words
    .join(" ")
    .replace(/\s+([,.!?;:%)\]}])/g, "$1")
    .replace(/([([{$])\s+/g, "$1")
    .replace(/\s+('[a-z]\b|n't\b)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Group word-level segments into turns by runs of the same speaker. */
function buildTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = [];

  segments.forEach((segment, index) => {
    const text = segment.text?.trim();
    if (!text) return;

    const speaker = segment.speaker ?? null;
    const start = segment.start ?? 0;
    const end = segment.end ?? start;
    const current = turns.at(-1);

    if (current && current.speaker === speaker) {
      if (start - current.lastEnd >= PARAGRAPH_GAP_S) current.paragraphs.push([]);
      current.paragraphs.at(-1)!.push(text);
      current.lastEnd = end;
      current.indices.push(index);
    } else {
      turns.push({ speaker, start, lastEnd: end, paragraphs: [[text]], indices: [index] });
    }
  });

  return turns;
}

const turnText = (turn: Turn): string => turn.paragraphs.flat().join(" ");

/**
 * Reassign leading sentence-fragments that the diarizer split onto the wrong
 * speaker. Only the fragment up to the first sentence-final token moves, so a
 * single bad boundary cannot cascade and swallow a whole turn.
 */
function repairDiarization(segments: Segment[]): { segments: Segment[]; moved: number } {
  const repaired = segments.map((segment) => ({ ...segment }));
  const turns = buildTurns(repaired);
  let moved = 0;

  let prevSpeaker = turns[0]?.speaker ?? null;
  let prevText = turns[0] ? turnText(turns[0]) : "";

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i]!;
    const text = turnText(turn);
    const firstWord = text.split(/\s+/)[0] ?? "";

    if (STARTS_LOWERCASE.test(firstWord) && !SENTENCE_END.test(prevText)) {
      const fragment: number[] = [];
      for (const index of turn.indices) {
        fragment.push(index);
        if (SENTENCE_END.test(repaired[index]!.text?.trim() ?? "")) break;
      }
      for (const index of fragment) repaired[index]!.speaker = prevSpeaker;
      moved++;

      if (fragment.length === turn.indices.length) {
        // Whole turn was a continuation: the previous speaker still holds the floor.
        prevText += ` ${text}`;
        continue;
      }
    }

    prevSpeaker = turn.speaker;
    prevText = text;
  }

  return { segments: repaired, moved };
}

/** Longest turn (in words) still treated as a pure backchannel. */
const BACKCHANNEL_MAX_WORDS = 3;

/**
 * In a two-person call the diarizer sometimes parks a stray "Yeah." / "Mhmm."
 * on a third speaker id that never otherwise appears. A backchannel comes from
 * whoever is *not* holding the floor, so attribute it to the other named
 * speaker. Only runs when the part names exactly two people.
 */
function attributeBackchannels(segments: Segment[], names: Record<string, string>): Segment[] {
  const named = Object.keys(names).map(Number);
  if (named.length !== 2) return segments;

  const result = segments.map((segment) => ({ ...segment }));
  const turns = buildTurns(result);
  let floor: number | null = null;

  for (const turn of turns) {
    const speaker = turn.speaker;
    if (speaker !== null && named.includes(speaker)) {
      floor = speaker;
      continue;
    }
    const words = turnText(turn).split(/\s+/).filter(Boolean).length;
    if (words > BACKCHANNEL_MAX_WORDS || floor === null) continue;

    const other = named.find((id) => id !== floor);
    if (other === undefined) continue;
    for (const index of turn.indices) result[index]!.speaker = other;
  }

  return result;
}

function localTime(datetime: string | undefined, offsetHours: number): string | undefined {
  if (!datetime) return undefined;
  const utc = new Date(`${datetime}Z`);
  if (Number.isNaN(utc.getTime())) return undefined;
  const shifted = new Date(utc.getTime() + offsetHours * 3600_000);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

interface RenderOptions {
  sourceName: string;
  sourcePath: string;
  meta: Meta;
  part: PartConfig;
  segments: Segment[];
  moved: number;
  offsetHours: number;
  repaired: boolean;
  frontmatter: boolean;
}

const yamlList = (values: string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

/** Vault-convention frontmatter, mirroring the existing Notion-era Sources notes. */
function frontmatterFor(
  meta: Meta,
  part: PartConfig,
  title: string,
  offsetHours: number,
  sourcePath: string,
): string[] {
  const utc = meta.datetime ? new Date(`${meta.datetime}Z`) : undefined;
  const startMs =
    utc && !Number.isNaN(utc.getTime())
      ? utc.getTime() + offsetHours * 3600_000 + (part.from ?? 0) * 1000
      : undefined;
  const local = startMs === undefined ? undefined : new Date(startMs).toISOString();
  const sign = offsetHours <= 0 ? "-" : "+";
  const offsetLabel = `UTC${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;

  return [
    "---",
    "type: source",
    `title: ${JSON.stringify(title)}`,
    ...(local ? [`date: ${local.slice(0, 10)}`] : []),
    ...(local ? [`time: ${JSON.stringify(`${local.slice(11, 16)} (${offsetLabel})`)}`] : []),
    `attendees: ${yamlList(part.attendees ?? [])}`,
    "project: []",
    `source: ${JSON.stringify(sourcePath)}`,
    "---",
    "",
  ];
}

function render({
  sourceName,
  sourcePath,
  meta,
  part,
  segments,
  moved,
  offsetHours,
  repaired,
  frontmatter,
}: RenderOptions): string {
  const title = frontmatter
    ? (part.vaultName ?? part.slug ?? basename(sourceName, extname(sourceName)))
    : (part.slug ?? basename(sourceName, extname(sourceName)));
  const lines: string[] = frontmatter
    ? [...frontmatterFor(meta, part, title.replace(/^Meeting \d{4}-\d{2}-\d{2} - /, ""), offsetHours, sourcePath), `# ${title}`, ""]
    : [`# ${title}`, ""];

  const from = part.from ?? 0;
  const to = part.to;
  const names = part.speakers ?? {};
  const inRange = segments.filter((segment) => {
    const start = segment.start ?? 0;
    return start >= from && (to === undefined || start < to);
  });
  const selected = attributeBackchannels(inRange, names);

  const spanStart = selected[0]?.start ?? from;
  const spanEnd = selected.at(-1)?.end ?? to ?? 0;
  const nameFor = (speaker: number | null): string =>
    speaker === null ? "Unknown" : (names[String(speaker)] ?? `Speaker ${speaker}`);

  const turns = buildTurns(selected);
  const speakers = [...new Set(turns.map((t) => t.speaker))].sort(
    (a, b) => (a ?? Infinity) - (b ?? Infinity),
  );

  const started = localTime(meta.datetime, offsetHours);
  const fields: [string, string | undefined][] = [
    ["Recorded", started ? `${started} local (${meta.datetime} UTC)` : meta.datetime],
    ["Segment", `${timestamp(spanStart)} - ${timestamp(spanEnd)} (${((spanEnd - spanStart) / 60).toFixed(1)} min)`],
    ["Calendar", part.event],
    ["Speakers", speakers.map((s) => nameFor(s)).join(", ")],
    ["Turns", String(turns.length)],
    ["Model", meta.modelName],
    ["Source", sourcePath],
  ];
  for (const [label, value] of fields) {
    if (value) lines.push(`- **${label}:** ${value}`);
  }

  if (part.confidence) lines.push(`- **Speaker ID confidence:** ${part.confidence}`);
  if (part.basis) lines.push("", `> **How speakers were identified:** ${part.basis}`);
  if (repaired && moved > 0) {
    lines.push(
      "",
      `> Diarization repair: ${moved} leading sentence-fragment${moved === 1 ? "" : "s"} reassigned to the speaker who was mid-sentence. Attribution is still approximate - short interjections are the least reliable.`,
    );
  }

  lines.push("", "---", "");

  if (selected.length === 0) {
    const text = (meta.result ?? meta.rawResult ?? "").trim();
    lines.push("> No segments in this range; flat transcript below.", "", text || "_(empty)_", "");
    return lines.join("\n");
  }

  for (const turn of turns) {
    lines.push(`**${nameFor(turn.speaker)}** \`[${timestamp(turn.start)}]\``, "");
    for (const paragraph of turn.paragraphs) {
      const body = joinWords(paragraph);
      if (body) lines.push(body, "");
    }
  }

  return lines.join("\n");
}

interface Args {
  files: string[];
  outdir?: string;
  config?: string;
  repair: boolean;
  frontmatter: boolean;
}

function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  let outdir: string | undefined;
  let config: string | undefined;
  let repair = true;
  let frontmatter = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o" || arg === "--outdir") {
      outdir = argv[++i];
      if (!outdir) throw new Error(`${arg} requires a directory`);
    } else if (arg === "-c" || arg === "--config") {
      config = argv[++i];
      if (!config) throw new Error(`${arg} requires a file`);
    } else if (arg === "--raw-speakers") {
      repair = false;
    } else if (arg === "--frontmatter") {
      frontmatter = true;
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    throw new Error(
      "usage: transcript-to-md.ts FILE.json [...] [-c CONFIG] [-o OUTDIR] [--raw-speakers] [--frontmatter]",
    );
  }
  return { files, outdir, config, repair, frontmatter };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }

  let config: Config = {};
  if (args.config) {
    config = JSON.parse(await readFile(args.config, "utf8")) as Config;
  }
  const offsetHours = typeof config.utcOffsetHours === "number" ? config.utcOffsetHours : 0;

  for (const file of args.files) {
    let meta: Meta;
    try {
      meta = JSON.parse(await readFile(file, "utf8")) as Meta;
    } catch (error) {
      console.error(`skip ${file}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    // Recordings all name their file meta.json; the recording id is the directory.
    const stem = basename(file, extname(file));
    const key = stem === "meta" ? basename(dirname(file)) : stem;
    const entry = config[key];
    const fileConfig: FileConfig =
      entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as FileConfig) : {};

    const raw = (meta.segments ?? []).filter((segment) => (segment.text ?? "").trim());
    const { segments, moved } = args.repair
      ? repairDiarization(raw)
      : { segments: raw, moved: 0 };

    const parts: PartConfig[] = fileConfig.parts ?? [fileConfig];
    const outdir = args.outdir ?? dirname(file);
    await mkdir(outdir, { recursive: true });

    for (const part of parts) {
      if (args.frontmatter && part.vault === false) continue;
      const name = args.frontmatter
        ? (part.vaultName ?? part.slug ?? key)
        : `${part.slug ?? key} - transcript`;
      const out = join(outdir, `${name}.md`);
      await writeFile(
        out,
        render({
          sourceName: key,
          sourcePath: originalMetaPath(key, config.originalsRoot) ?? basename(file),
          meta,
          part,
          segments,
          moved,
          offsetHours,
          repaired: args.repair,
          frontmatter: args.frontmatter,
        }),
        "utf8",
      );
      console.log(`${basename(out)}`);
    }
  }
}

await main();
