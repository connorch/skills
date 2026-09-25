// "214.9 kB" style sizes for the listing columns.
export function formatSize(bytes: number): string {
  let value = bytes
  let unit = "B"
  for (const next of ["kB", "MB", "GB"]) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

// "Aug 20" within the current year, "2025-08-20" otherwise.
export function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`
  }
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// "2026-09-02 17:40" in local time, for Versions and the details pane.
export function formatStamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
