import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { fetchAllFiles, type FileEntry } from "@/lib/api"
import { formatSize, formatWhen } from "@/lib/format"
import {
  parseToken,
  searchFiles,
  splitInput,
  suggestValues,
  TOKEN_NAMES,
  type Match,
  type Token,
} from "@/lib/search"

// Rendering hundreds of rows is pointless - the ranking puts the answer on top.
const MAX_RESULTS = 100
const MAX_SUGGESTIONS = 8

// The ⌘K global search: one input over every File in the bucket, free text
// fuzzy-matching the Key plus `name:value` filter tokens (see lib/search).
// Finished tokens turn into chips inside the input; an unfinished one opens
// value autocomplete. Enter opens the File, ⌘Enter copies its URL, → goes to
// its Directory Route.
export function SearchPalette({
  open,
  onOpenChange,
  prefix,
  navigate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // The Directory Route the palette was opened from ("" at root), offered as
  // an `in:` chip so narrowing back to "this directory" is one click.
  prefix: string
  navigate: (to: string) => void
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [tokens, setTokens] = useState<Token[]>([])
  const [text, setText] = useState("")
  const [selected, setSelected] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Refetch on every open (one cheap list call) so CLI uploads since the last
  // open show up; stale results stay visible while the fetch is in flight.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchAllFiles().then(
      (listing) => {
        if (!cancelled) setFiles(listing.files)
      },
      (cause: unknown) => {
        if (!cancelled)
          toast.error(cause instanceof Error ? cause.message : "search failed")
      }
    )
    return () => {
      cancelled = true
    }
  }, [open])

  // Every open starts from a blank query (state adjusted during render, the
  // React-sanctioned way to reset on a prop change).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTokens([])
      setText("")
    }
  }

  const { words, pending } = splitInput(text)
  const matches = files ? searchFiles(files, tokens, words) : []
  const suggestions = pending
    ? suggestValues(
        matches.map((m) => m.file),
        pending.name,
        pending.value
      ).slice(0, MAX_SUGGESTIONS)
    : []

  const close = () => onOpenChange(false)

  const addToken = (token: Token) => {
    setTokens((current) => [...current, token])
    // Drop the half-typed token word the chip replaces.
    setText(
      pending ? text.slice(0, text.lastIndexOf(`${pending.name}:`)) : text
    )
    inputRef.current?.focus()
  }

  const removeToken = (index: number) => {
    setTokens((current) => current.filter((_, i) => i !== index))
    inputRef.current?.focus()
  }

  // A space after a complete `name:value` commits it as a chip.
  const onInput = (value: string) => {
    const last = value.trimEnd().split(/\s+/).pop() ?? ""
    const token = /\s$/.test(value) ? parseToken(last) : null
    if (token && token.value) {
      setTokens((current) => [...current, token])
      setText(value.trimEnd().slice(0, -last.length))
    } else {
      setText(value)
    }
  }

  const selectedKey = selected.startsWith("file:")
    ? selected.slice("file:".length)
    : null

  const copyUrl = (key: string) =>
    navigator.clipboard.writeText(`${window.location.origin}/${key}`).then(
      () => toast.success("URL copied"),
      () => toast.error("copy failed")
    )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const input = inputRef.current
    if (event.key === "Backspace" && text === "" && tokens.length > 0) {
      event.preventDefault()
      removeToken(tokens.length - 1)
    } else if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      selectedKey
    ) {
      event.preventDefault()
      copyUrl(selectedKey)
      close()
    } else if (
      event.key === "ArrowRight" &&
      selectedKey &&
      input &&
      input.selectionStart === input.value.length
    ) {
      event.preventDefault()
      navigate(`/${selectedKey.replace(/[^/]*$/, "")}`)
      close()
    }
  }

  const empty = words.length === 0 && tokens.length === 0
  const shown = matches.slice(0, MAX_RESULTS)

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search files"
      description="Search every File by Key, with project, branch, type, is and in filters."
      className="font-mono text-[13px] sm:max-w-3xl"
    >
      <Command
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={onKeyDown}
      >
        <CommandInput
          ref={inputRef}
          placeholder={tokens.length ? "" : "search all files"}
          value={text}
          onValueChange={onInput}
          className="font-mono text-[13px]"
        >
          {tokens.length > 0 &&
            tokens.map((token, index) => (
              <Chip
                key={`${token.name}:${token.value}:${index}`}
                onClick={() => removeToken(index)}
              >
                {token.name}:{token.value}
                <span className="opacity-60"> ×</span>
              </Chip>
            ))}
        </CommandInput>

        {empty && !pending && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-xs text-muted-foreground">
            filters:
            {TOKEN_NAMES.map((name) => (
              <Chip
                key={name}
                onClick={() => {
                  setText(`${name}:`)
                  inputRef.current?.focus()
                }}
              >
                {name}:
              </Chip>
            ))}
            {prefix !== "" && (
              <Chip onClick={() => addToken({ name: "in", value: prefix })}>
                in:{prefix}
              </Chip>
            )}
          </div>
        )}

        <CommandList className="max-h-96">
          {files === null ? (
            <div className="py-6 text-center text-muted-foreground">
              loading
            </div>
          ) : (
            <CommandEmpty className="text-muted-foreground">
              no matches
            </CommandEmpty>
          )}
          {pending && suggestions.length > 0 && (
            <CommandGroup heading={`${pending.name}:`}>
              {suggestions.map((suggestion) => (
                <CommandItem
                  key={suggestion.value}
                  value={`token:${pending.name}:${suggestion.value}`}
                  onSelect={() =>
                    addToken({ name: pending.name, value: suggestion.value })
                  }
                  className="py-1"
                >
                  <span className="truncate">{suggestion.value}</span>
                  <CommandShortcut className="tracking-normal">
                    {suggestion.count}
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {shown.length > 0 && (
            <CommandGroup heading={empty ? "recent" : "files"}>
              {shown.map((match) => (
                <FileItem
                  key={match.file.key}
                  match={match}
                  onOpen={() => {
                    window.open(`/${match.file.key}`, "_blank", "noopener")
                    close()
                  }}
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>

        <div className="flex items-center gap-4 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>⌘↵</Kbd> copy url
          </span>
          <span>
            <Kbd>→</Kbd> directory
          </span>
          {files !== null && (
            <span className="ml-auto">
              {matches.length > MAX_RESULTS
                ? `${MAX_RESULTS}+`
                : matches.length}{" "}
              match
              {matches.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </Command>
    </CommandDialog>
  )
}

function FileItem({ match, onOpen }: { match: Match; onOpen: () => void }) {
  const { file } = match
  const context = [file.project, file.branch].filter(Boolean).join(" · ")
  return (
    <CommandItem value={`file:${file.key}`} onSelect={onOpen} className="py-1">
      <span className="min-w-0 flex-1 truncate">
        <HighlightedKey fileKey={file.key} hits={match.hits} />
      </span>
      {file.visibility === "public" && (
        <Badge variant="secondary">public</Badge>
      )}
      {file.stable && <Badge variant="outline">stable</Badge>}
      {/* Git context can be long; it yields to the Key and truncates. */}
      <CommandShortcut
        className="max-w-[45%] min-w-0 truncate tracking-normal"
        title={context || undefined}
      >
        {[context, formatSize(file.size), formatWhen(file.uploaded)]
          .filter(Boolean)
          .join(" · ")}
      </CommandShortcut>
    </CommandItem>
  )
}

// The Key with its directory part muted and matched characters underlined.
function HighlightedKey({
  fileKey,
  hits,
}: {
  fileKey: string
  hits: Set<number>
}) {
  const nameStart = fileKey.lastIndexOf("/") + 1
  return (
    <>
      {[...fileKey].map((char, index) => (
        <span
          key={index}
          className={
            (index < nameStart ? "text-muted-foreground" : "") +
            (hits.has(index) ? " font-semibold text-foreground underline" : "")
          }
        >
          {char}
        </span>
      ))}
    </>
  )
}

function Chip({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded bg-secondary px-1.5 text-xs whitespace-nowrap text-secondary-foreground hover:bg-accent"
    >
      {children}
    </button>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-mono text-[11px]">
      {children}
    </kbd>
  )
}
