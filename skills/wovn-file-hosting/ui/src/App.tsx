// Browse UI for files.wovn.org: one table per directory level, driven by the
// worker's /_/api/browse endpoint. The current prefix lives in the ?prefix=
// query param (pushState/popstate) so views are copyable and back/forward
// work.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import {
  CornerLeftUpIcon,
  FolderIcon,
  RotateCwIcon,
  SearchXIcon,
} from "lucide-react"

import { FileRow } from "@/components/file-row"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { browse, type BrowseResult } from "@/lib/api"

// Query marker the /login redirect appends; stripped on load so copied URLs
// stay clean.
const LOGIN_MARKER = "wovn-authed"

function prefixFromLocation(): string {
  return new URLSearchParams(window.location.search).get("prefix") ?? ""
}

// ?prefix= keeps its slashes readable (2026/08/, not 2026%2F08%2F).
function urlFor(prefix: string): string {
  return prefix
    ? `/_/?prefix=${encodeURIComponent(prefix).replaceAll("%2F", "/")}`
    : "/_/"
}

export function App() {
  const [prefix, setPrefix] = useState(prefixFromLocation)
  const [filter, setFilter] = useState("")
  // The last completed browse call, keyed by the request that produced it;
  // a stale key (prefix or generation moved on) reads as still loading.
  const [loaded, setLoaded] = useState<{
    key: string
    listing?: BrowseResult
    error?: string
  } | null>(null)
  const [generation, setGeneration] = useState(0)

  const reload = useCallback(() => setGeneration((n) => n + 1), [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has(LOGIN_MARKER)) {
      params.delete(LOGIN_MARKER)
      const query = params.toString()
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (query ? `?${query}` : "")
      )
    }
  }, [])

  useEffect(() => {
    const onPopState = () => {
      setPrefix(prefixFromLocation())
      setFilter("")
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  useEffect(() => {
    let cancelled = false
    const key = `${generation}#${prefix}`
    browse(prefix)
      .then((result) => {
        if (!cancelled) setLoaded({ key, listing: result })
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ key, error: String(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [prefix, generation])

  const current = loaded?.key === `${generation}#${prefix}` ? loaded : null
  const listing = current?.listing ?? null
  const error = current?.error ?? null

  const navigate = useCallback((next: string) => {
    window.history.pushState(null, "", urlFor(next))
    setPrefix(next)
    setFilter("")
  }, [])

  const segments = useMemo(() => prefix.split("/").filter(Boolean), [prefix])
  const parent = segments.length > 1 ? `${segments.slice(0, -1).join("/")}/` : ""
  const query = filter.trim().toLowerCase()

  const folders = useMemo(
    () =>
      (listing?.prefixes ?? [])
        .map((p) => ({ prefix: p, name: p.slice(prefix.length, -1) }))
        .filter((folder) => folder.name.toLowerCase().includes(query)),
    [listing, prefix, query]
  )
  const files = useMemo(
    () =>
      (listing?.files ?? [])
        .map((file) => ({ file, name: file.key.slice(prefix.length) }))
        .filter((entry) => entry.name.toLowerCase().includes(query)),
    [listing, prefix, query]
  )

  const loading = listing === null && error === null
  const empty = listing !== null && folders.length === 0 && files.length === 0
  const filtered = empty && (listing.prefixes.length > 0 || listing.files.length > 0)

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-4xl flex-col gap-3 px-4 py-5">
      <header className="flex items-center gap-3">
        <a
          href="/_/"
          onClick={(event) => {
            event.preventDefault()
            navigate("")
          }}
          className="font-mono text-sm font-semibold tracking-tight"
        >
          wovn
        </a>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter"
          className="ml-auto h-8 w-56"
        />
      </header>

      <Breadcrumb>
        <BreadcrumbList className="font-mono text-xs">
          <BreadcrumbItem>
            {segments.length === 0 ? (
              <BreadcrumbPage>files.wovn.org</BreadcrumbPage>
            ) : (
              <BreadcrumbLink
                href="/_/"
                onClick={(event) => {
                  event.preventDefault()
                  navigate("")
                }}
              >
                files.wovn.org
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {segments.map((segment, index) => {
            const target = `${segments.slice(0, index + 1).join("/")}/`
            const last = index === segments.length - 1
            return (
              <Fragment key={target}>
                <BreadcrumbSeparator>›</BreadcrumbSeparator>
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage>{segment}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      href={urlFor(target)}
                      onClick={(event) => {
                        event.preventDefault()
                        navigate(target)
                      }}
                    >
                      {segment}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>

      {error !== null ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Failed to load</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={reload}>
            <RotateCwIcon data-icon="inline-start" />
            Retry
          </Button>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="w-24 text-right">Size</TableHead>
              <TableHead className="w-28">Uploaded</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }, (_, index) => (
                <TableRow key={index} className="hover:bg-transparent">
                  <TableCell className="py-2">
                    <Skeleton className="h-4 w-64 animate-none" />
                  </TableCell>
                  <TableCell className="py-2">
                    <Skeleton className="ml-auto h-4 w-12 animate-none" />
                  </TableCell>
                  <TableCell className="py-2">
                    <Skeleton className="h-4 w-20 animate-none" />
                  </TableCell>
                  <TableCell className="py-2">
                    <Skeleton className="ml-auto h-4 w-24 animate-none" />
                  </TableCell>
                </TableRow>
              ))
            ) : empty ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-10">
                  <Empty>
                    <EmptyHeader>
                      {filtered && (
                        <EmptyMedia variant="icon">
                          <SearchXIcon />
                        </EmptyMedia>
                      )}
                      <EmptyTitle>
                        {filtered ? "No matches" : "Empty folder"}
                      </EmptyTitle>
                      {filtered && (
                        <EmptyDescription>
                          Nothing here matches "{filter.trim()}"
                        </EmptyDescription>
                      )}
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              <>
                {prefix !== "" && (
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => navigate(parent)}
                  >
                    <TableCell colSpan={4} className="py-1.5">
                      <span className="flex items-center gap-2 font-mono text-[13px] text-muted-foreground">
                        <CornerLeftUpIcon className="size-3.5" />
                        ..
                      </span>
                    </TableCell>
                  </TableRow>
                )}
                {folders.map((folder) => (
                  <TableRow
                    key={folder.prefix}
                    className="cursor-pointer"
                    onClick={() => navigate(folder.prefix)}
                  >
                    <TableCell className="py-1.5" colSpan={4}>
                      <span className="flex items-center gap-2 font-mono text-[13px]">
                        <FolderIcon className="size-3.5 fill-muted-foreground/20 text-muted-foreground" />
                        {folder.name}/
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {files.map(({ file, name }) => (
                  <FileRow
                    key={file.key}
                    file={file}
                    name={name}
                    onDeleted={reload}
                  />
                ))}
              </>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

export default App
