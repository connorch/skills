import { Fragment, useEffect, useState, type ReactNode } from "react"

import { SearchPalette } from "@/components/search-palette"

// The one-line strip at the top of every app surface: the breadcrumb on the
// left, page-specific controls on the right, and the ⌘K search that also
// answers the keyboard from anywhere on the page.
export function Strip({
  crumbs,
  prefix,
  children,
  after,
}: {
  crumbs: ReactNode
  // The Directory Route the search palette offers as an `in:` chip.
  prefix: string
  // Controls before the ⌘K hint, and after it (the Banner's chevron).
  children?: ReactNode
  after?: ReactNode
}) {
  const [searchOpen, setSearchOpen] = useState(false)

  // ⌘K / Ctrl+K toggles the search palette; `/` opens it unless a text field
  // already has focus. Listens on window so it works over an HTML File too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSearchOpen((open) => !open)
      } else if (event.key === "/" && !isEditable(event)) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Drop the ?wovn-authed=1 marker the /login flow appends, so copied URLs
  // stay clean.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("wovn-authed")) {
      url.searchParams.delete("wovn-authed")
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`
      )
    }
  }, [])

  return (
    <div className="flex h-[30px] items-center gap-2.5 border-b border-border bg-card px-2.5 font-mono text-[12.5px] whitespace-nowrap">
      {crumbs}
      <div className="ml-auto flex items-center gap-2.5 text-muted-foreground">
        {children}
        <button
          type="button"
          className="cursor-pointer rounded border border-border px-1 text-[11px] hover:bg-accent"
          title="search all files"
          onClick={() => setSearchOpen(true)}
        >
          ⌘K
        </button>
        {after}
      </div>
      <SearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        prefix={prefix}
      />
    </div>
  )
}

// Inside an HTML File the event target can be in the File's own document or
// in the Banner's shadow root; composedPath sees both.
function isEditable(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof HTMLElement &&
        (node.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))
    )
}

// "files.wovn.org › a › b": every crumb but the last is a link to its
// Directory Route; `tail` renders the last one (a File name, or a Version).
export function Crumbs({
  segments,
  tail,
}: {
  segments: string[]
  tail: ReactNode
}) {
  return (
    <nav className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {segments.length === 0 && tail === null ? (
        <span className="font-semibold">files.wovn.org</span>
      ) : (
        <a className="text-muted-foreground hover:underline" href="/">
          files.wovn.org
        </a>
      )}
      {segments.map((segment, index) => {
        const directory = `/${segments.slice(0, index + 1).join("/")}/`
        const last = tail === null && index === segments.length - 1
        return (
          <Fragment key={directory}>
            <Sep />
            {last ? (
              <span className="truncate font-semibold">{segment}</span>
            ) : (
              <a
                className="truncate text-muted-foreground hover:underline"
                href={directory}
              >
                {segment}
              </a>
            )}
          </Fragment>
        )
      })}
      {tail !== null && (
        <>
          <Sep />
          {tail}
        </>
      )}
    </nav>
  )
}

export function Sep() {
  return <span className="text-muted-foreground/60">›</span>
}

// A muted "·" between controls in the strip's right side.
export function Dot() {
  return <span className="text-muted-foreground/40">·</span>
}
