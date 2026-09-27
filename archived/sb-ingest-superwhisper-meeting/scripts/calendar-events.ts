#!/usr/bin/env bun
/**
 * Fetch Google Calendar events for a date range via the `gws` CLI.
 *
 * Usage:
 *   ./calendar-events.ts --from 2026-07-13 --to 2026-07-17 [--calendar you@example.com]
 *
 * Emits normalised JSON: start/end in local time, summary, and attendees with
 * email + display name, so recordings can be matched to events and attendee
 * lists can seed speaker identification.
 *
 * Notes on gws: it prints a "Using keyring backend" line to stderr and its
 * `--format json` flag rejects this request shape, so the default output is
 * parsed and everything before the first `{` is discarded.
 */

import { $ } from "bun";

interface RawAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  responseStatus?: string;
  resource?: boolean;
  self?: boolean;
}

interface RawEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: RawAttendee[];
  location?: string;
  status?: string;
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: { email: string; name?: string; organizer: boolean; response?: string }[];
}

function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export function parseGwsJson(output: string): RawEvent[] {
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`no JSON in gws output: ${output.slice(0, 200)}`);
  const parsed = JSON.parse(output.slice(start)) as { items?: RawEvent[]; error?: unknown };
  if (parsed.error) throw new Error(`gws error: ${JSON.stringify(parsed.error)}`);
  return parsed.items ?? [];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const from = flag(argv, "--from");
  const to = flag(argv, "--to");
  const calendarId = flag(argv, "--calendar", "primary")!;
  if (!from || !to) {
    console.error("usage: calendar-events.ts --from YYYY-MM-DD --to YYYY-MM-DD [--calendar ID]");
    process.exit(2);
  }

  // Local-midnight bounds; the API treats a bare date as UTC, which would clip edge events.
  const params = JSON.stringify({
    calendarId,
    timeMin: new Date(`${from}T00:00:00`).toISOString(),
    timeMax: new Date(`${to}T23:59:59`).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const raw = await $`gws calendar events list --params ${params}`.quiet().text();
  const events: CalendarEvent[] = parseGwsJson(raw)
    .filter((event) => event.status !== "cancelled")
    .map((event) => {
      const start = event.start?.dateTime ?? event.start?.date ?? "";
      const end = event.end?.dateTime ?? event.end?.date ?? "";
      return {
        summary: event.summary ?? "(no title)",
        start: start.length > 10 ? new Date(start).toLocaleString("sv-SE").slice(0, 16) : start,
        end: end.length > 10 ? new Date(end).toLocaleString("sv-SE").slice(0, 16) : end,
        allDay: start.length <= 10,
        attendees: (event.attendees ?? [])
          .filter((a) => !a.resource)
          .map((a) => ({
            email: a.email ?? "",
            ...(a.displayName ? { name: a.displayName } : {}),
            organizer: Boolean(a.organizer),
            ...(a.responseStatus ? { response: a.responseStatus } : {}),
          })),
      };
    });

  console.log(JSON.stringify(events, null, 2));
}

await main();
