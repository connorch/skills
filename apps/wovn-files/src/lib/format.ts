// "214.9 kB" style sizes for the listing columns.
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = "B";
  for (const next of ["kB", "MB", "GB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Aug 20" within the current year, "2025-08-20" otherwise.
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "2026-09-02 17:40" in local time, for Versions and the details pane.
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "just now", "12m ago", "3h ago", "yesterday", "4d ago", then the date.
export function formatAgo(iso: string, now: number): string {
  const minutes = (now - new Date(iso).getTime()) / 60_000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / (60 * 24));
  if (days === 1) return "yesterday";
  return days < 7 ? `${days}d ago` : formatWhen(iso);
}

// "Sep 29, 07:34" in local time, for a Version row.
export function formatDayTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "Tue Sep 29, 07:34" in local time, for the exact time behind a relative one.
export function formatLong(iso: string): string {
  const day = new Date(iso).toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${formatDayTime(iso)}`;
}

// "+2.6 kB" / "-1.0 kB" between two sizes; empty when they match.
export function formatDelta(bytes: number): string {
  if (bytes === 0) return "";
  return `${bytes > 0 ? "+" : "-"}${formatSize(Math.abs(bytes))}`;
}
