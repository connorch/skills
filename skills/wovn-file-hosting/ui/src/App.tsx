import { Fragment, useCallback, useEffect, useState } from "react"

import { DirectoryView } from "@/components/directory-view"
import { HistoryView } from "@/components/history-view"
import { SearchPalette } from "@/components/search-palette"
import { Toaster } from "@/components/ui/sonner"
import { navClick } from "@/lib/format"

// The worker serves this shell for every Directory Route - any authenticated
// browser GET whose path has no exact Key match (ADR 0002). The path IS the
// state: /<prefix>/ lists the Files under that prefix ("" = root), and
// /<key>/archive shows a File's Versions. Navigation is pushState over real
// links, so back/forward and open-in-new-tab behave like a plain site.
interface Route {
  kind: "listing" | "archive"
  // listing: the prefix ("" or ending in "/"); archive: the File's Key.
  target: string
}

function parseRoute(pathname: string): Route {
  const path = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, "")
  if (path === "") return { kind: "listing", target: "" }
  const segments = path.split("/")
  // `archive` is a Reserved Key in every segment, so a trailing one can only
  // be the Version-history alias route.
  if (segments.length > 1 && segments[segments.length - 1] === "archive") {
    return { kind: "archive", target: segments.slice(0, -1).join("/") }
  }
  return { kind: "listing", target: `${path}/` }
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname)
  const [searchOpen, setSearchOpen] = useState(false)

  // Drop the ?wovn-authed=1 marker the /login flow appends, so copied URLs
  // stay clean.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("wovn-authed")) {
      url.searchParams.delete("wovn-authed")
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  // ⌘K / Ctrl+K toggles the search palette from anywhere; `/` opens it unless
  // a text field already has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSearchOpen((open) => !open)
      } else if (
        event.key === "/" &&
        !(event.target instanceof HTMLElement && event.target.closest("input, textarea"))
      ) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to)
    setPath(to)
  }, [])

  const route = parseRoute(path)

  useEffect(() => {
    document.title = route.target ? `files.wovn.org/${route.target}` : "files.wovn.org"
  }, [route.target])

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 font-mono text-[13px]">
      <div className="flex items-center gap-4 border-b border-border pb-2">
        <Breadcrumb route={route} navigate={navigate} />
        <button
          type="button"
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-accent"
          onClick={() => setSearchOpen(true)}
        >
          search <kbd className="rounded border border-border px-1 text-[11px]">⌘K</kbd>
        </button>
      </div>
      <main className="pt-1">
        {route.kind === "listing" ? (
          <DirectoryView key={path} prefix={route.target} navigate={navigate} />
        ) : (
          <HistoryView key={path} fileKey={route.target} />
        )}
      </main>
      <SearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        // On the archive view, the File's own directory.
        prefix={route.kind === "listing" ? route.target : route.target.replace(/[^/]*$/, "")}
        navigate={navigate}
      />
      <Toaster />
    </div>
  )
}

// "files.wovn.org › a › b": every crumb but the last navigates to its
// Directory Route; on the archive view the File's crumb links to the File
// itself (a real content URL, so it is a plain link, no pushState).
function Breadcrumb({ route, navigate }: { route: Route; navigate: (to: string) => void }) {
  const segments = route.target.replace(/\/+$/, "").split("/").filter(Boolean)
  const crumbs = route.kind === "archive" ? [...segments, "archive"] : segments

  return (
    <nav className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {crumbs.length === 0 ? (
        <span className="font-semibold">files.wovn.org</span>
      ) : (
        <a
          className="text-muted-foreground hover:underline"
          href="/"
          onClick={navClick(navigate, "/")}
        >
          files.wovn.org
        </a>
      )}
      {crumbs.map((segment, index) => {
        const last = index === crumbs.length - 1
        // On the archive view the second-to-last crumb is the File itself.
        const isFileCrumb = route.kind === "archive" && index === crumbs.length - 2
        const directory = `/${crumbs.slice(0, index + 1).join("/")}/`
        return (
          <Fragment key={directory}>
            <span className="text-muted-foreground">›</span>
            {last ? (
              <span className="truncate font-semibold">{segment}</span>
            ) : isFileCrumb ? (
              <a className="truncate text-muted-foreground hover:underline" href={`/${segments.join("/")}`}>
                {segment}
              </a>
            ) : (
              <a
                className="truncate text-muted-foreground hover:underline"
                href={directory}
                onClick={navClick(navigate, directory)}
              >
                {segment}
              </a>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
