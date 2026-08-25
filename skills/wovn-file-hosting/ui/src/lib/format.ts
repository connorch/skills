// Compact SI sizes: 999 B, 18.2 kB, 141 MB.
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ["kB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  do {
    value /= 1000
    unit++
  } while (value >= 1000 && unit < units.length)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit - 1]}`
}

// Compact local time: 14:32 today, Aug 21 14:32 this year, 2025 Aug 21 older.
export function formatTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  if (date.toDateString() === now.toDateString()) return time
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" })
  if (date.getFullYear() === now.getFullYear()) return `${day} ${time}`
  return `${date.getFullYear()} ${day}`
}
