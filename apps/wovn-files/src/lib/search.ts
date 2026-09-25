import type { FileEntry } from "@/lib/api"

// Query grammar for the search palette: free text fuzzy-matches the Key, and
// `name:value` tokens filter. project/branch/type mirror the worker's
// /api/files filters, `is:` covers the boolean stamps, and `in:` scopes to a
// Key prefix (the old per-directory filter, one token away).
export const TOKEN_NAMES = ["project", "branch", "type", "is", "in"] as const
export type TokenName = (typeof TOKEN_NAMES)[number]

export interface Token {
  name: TokenName
  value: string
}

const IS_VALUES = ["public", "private", "stable"] as const

// Mirrors TYPE_CATEGORIES in worker/src/index.ts; keep the two in sync.
const TYPE_CATEGORIES: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
  video: ["mp4", "webm", "mov"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "md", "html", "txt", "log"],
  data: ["json", "csv", "yaml", "yml"],
  archive: ["zip", "tar", "gz", "tgz"],
}

function isTokenName(name: string): name is TokenName {
  return (TOKEN_NAMES as readonly string[]).includes(name)
}

// "project:skills" -> { name, value }; anything else -> null. The value may be
// empty ("type:"), which callers treat as a token still being typed.
export function parseToken(word: string): Token | null {
  const colon = word.indexOf(":")
  if (colon === -1) return null
  const name = word.slice(0, colon)
  return isTokenName(name) ? { name, value: word.slice(colon + 1) } : null
}

// Splits raw input into words plus, when the last word is an unfinished
// token (no trailing space yet), that token so the UI can autocomplete it.
export function splitInput(text: string): {
  words: string[]
  pending: Token | null
} {
  const words = text.split(/\s+/).filter(Boolean)
  const last = words[words.length - 1]
  const pending = last && !/\s$/.test(text) ? parseToken(last) : null
  return { words: pending ? words.slice(0, -1) : words, pending }
}

export function extensionOf(key: string): string {
  const name = key.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

function matchesToken(file: FileEntry, { name, value }: Token): boolean {
  switch (name) {
    case "project":
      return file.project === value
    case "branch":
      return file.branch === value
    case "type": {
      const extension = extensionOf(file.key)
      return (TYPE_CATEGORIES[value] ?? [value]).includes(extension)
    }
    case "is":
      return value === "stable" ? file.stable : file.visibility === value
    case "in":
      return file.key.startsWith(value)
  }
}

export interface Match {
  file: FileEntry
  // Character positions in the Key that matched, for highlighting.
  hits: Set<number>
}

// One free-text word against a Key: a substring hit ranks above a scattered
// subsequence, and a hit inside the file name ranks above one in the
// directory part. Returns null when the word does not match at all.
function matchWord(
  key: string,
  word: string
): { score: number; hits: number[] } | null {
  const lower = key.toLowerCase()
  const at = lower.indexOf(word)
  if (at !== -1) {
    const inName = at >= lower.lastIndexOf("/") + 1
    return {
      score: inName ? 0 : 1,
      hits: Array.from({ length: word.length }, (_, i) => at + i),
    }
  }
  const hits: number[] = []
  let from = 0
  for (const char of word) {
    const index = lower.indexOf(char, from)
    if (index === -1) return null
    hits.push(index)
    from = index + 1
  }
  return { score: 2, hits }
}

// Files matching every token and every free-text word, best matches first
// (ties newest first). With no words at all this is simply newest first.
export function searchFiles(
  files: FileEntry[],
  tokens: Token[],
  words: string[]
): Match[] {
  const needles = words.map((w) => w.toLowerCase())
  const scored: { match: Match; score: number }[] = []
  for (const file of files) {
    if (!tokens.every((token) => matchesToken(file, token))) continue
    const hits = new Set<number>()
    let score = 0
    let failed = false
    for (const needle of needles) {
      const result = matchWord(file.key, needle)
      if (!result) {
        failed = true
        break
      }
      score += result.score
      for (const hit of result.hits) hits.add(hit)
    }
    if (failed) continue
    scored.push({ match: { file, hits }, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.match.file.uploaded.localeCompare(a.match.file.uploaded)
  )
  return scored.map((s) => s.match)
}

export interface Suggestion {
  value: string
  count: number
}

// Autocomplete values for a token being typed, with how many of `files`
// (already narrowed by the other tokens and words) each would keep. Only
// values that keep at least one File are offered.
export function suggestValues(
  files: FileEntry[],
  name: TokenName,
  partial: string
): Suggestion[] {
  const counts = new Map<string, number>()
  const bump = (value: string) =>
    counts.set(value, (counts.get(value) ?? 0) + 1)
  for (const file of files) {
    switch (name) {
      case "project":
        if (file.project) bump(file.project)
        break
      case "branch":
        if (file.branch) bump(file.branch)
        break
      case "type": {
        const extension = extensionOf(file.key)
        if (!extension) break
        bump(extension)
        for (const [category, extensions] of Object.entries(TYPE_CATEGORIES)) {
          if (extensions.includes(extension)) bump(category)
        }
        break
      }
      case "is":
        for (const value of IS_VALUES) {
          if (matchesToken(file, { name, value })) bump(value)
        }
        break
      case "in": {
        // Every ancestor directory of the Key.
        const segments = file.key.split("/")
        for (let depth = 1; depth < segments.length; depth++) {
          bump(`${segments.slice(0, depth).join("/")}/`)
        }
        break
      }
    }
  }
  const needle = partial.toLowerCase()
  return [...counts]
    .filter(([value]) => value.toLowerCase().includes(needle))
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}
