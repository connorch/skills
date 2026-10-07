import { useSyncExternalStore } from "react";

import { formatAgo, formatDayTime, formatIn, formatLong, formatStamp } from "@/lib/format";

const SHOW = {
  // "3h ago", with the exact time on hover.
  ago: (iso: string, now: number) => formatAgo(iso, now),
  // "in 6d", for a Share's expiry.
  in: (iso: string, now: number) => formatIn(iso, now),
  // "Sep 28, 22:34"
  day: (iso: string) => formatDayTime(iso),
  // "2026-09-28 22:34"
  stamp: (iso: string) => formatStamp(iso),
  // "Tue Sep 29, 07:34 (3h ago)"
  long: (iso: string, now: number) => `${formatLong(iso)} (${formatAgo(iso, now)})`,
};

// A time in the reader's clock. The server renders in UTC and earlier than
// the browser hydrates, so the server and the hydrating render both show the
// plain date ("2026-09-29"), and the local text replaces it after mount; it
// ticks each minute so a page left open stays true. `data-fresh` marks a
// time under an hour old, for callers that want it brighter.
export function Time({
  iso,
  show,
  className,
}: {
  iso: string;
  show: keyof typeof SHOW;
  className?: string;
}) {
  const now = useNow();
  const fresh = now !== null && now - new Date(iso).getTime() < 60 * 60_000;
  return (
    <time
      className={className}
      dateTime={iso}
      title={(show === "ago" || show === "in") && now !== null ? formatLong(iso) : undefined}
      data-fresh={fresh ? "" : undefined}
    >
      {now === null ? iso.slice(0, 10) : SHOW[show](iso, now)}
    </time>
  );
}

// The current minute, or null on the server and while hydrating (React
// renders the server snapshot first, then re-renders with the client one).
function useNow(): number | null {
  return useSyncExternalStore(subscribeMinutes, currentMinute, () => null);
}

function subscribeMinutes(onTick: () => void): () => void {
  const id = setInterval(onTick, 60_000);
  return () => clearInterval(id);
}

const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
