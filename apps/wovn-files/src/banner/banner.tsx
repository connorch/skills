import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { fileUrl, rawUrl } from "@/lib/api"
import { formatStamp } from "@/lib/format"
import { fileQuery } from "@/lib/queries"
import type { FilePage } from "@/lib/types"
import { versionStamp } from "@/lib/types"
import { Panel, type Tab } from "./panel"
import { Crumbs, Dot, Strip } from "./strip"
import { VisibilityBadge } from "./visibility-badge"

// The Banner (CONTEXT.md): the strip and its panel above a File. One
// component, two mounts - the React tree of an app page, and the shadow root
// the host injects into an HTML File. The File's Visibility is read through
// the query cache so a flip anywhere updates the badge.
export function Banner({ page }: { page: FilePage }) {
  const file = useQuery({
    ...fileQuery(page.file.key),
    initialData: page.file,
  }).data
  const [open, setOpen] = useState(page.openVersions)
  const [tab, setTab] = useState<Tab>(page.openVersions ? "versions" : "files")
  const segments = file.key.split("/")
  const name = segments.pop() ?? file.key
  const stamp = page.version ? versionStamp(page.version.key) : undefined
  const showTab = (next: Tab) => {
    setTab(next)
    setOpen(true)
  }

  const tail = page.version ? (
    <>
      <a
        className="truncate text-muted-foreground hover:underline"
        href={fileUrl(file.key)}
      >
        {name}
      </a>
      <span className="text-muted-foreground/60">›</span>
      <span className="truncate font-semibold text-private">
        version {formatStamp(page.version.uploaded)}
      </span>
      <span className="pl-1.5">
        <VisibilityBadge file={file} readOnly />
      </span>
      <span className="text-muted-foreground">{newerThan(page)}</span>
    </>
  ) : (
    <>
      <span className="truncate font-semibold">{name}</span>
      <span className="pl-1.5">
        <VisibilityBadge file={file} />
      </span>
    </>
  )

  const chevron = (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "collapse" : "expand"}
      className="cursor-pointer px-0.5 text-muted-foreground hover:text-foreground"
      onClick={() => setOpen((value) => !value)}
    >
      {open ? "▴" : "▾"}
    </button>
  )

  return (
    <div className="text-foreground">
      <Strip
        crumbs={<Crumbs segments={segments} tail={tail} />}
        prefix={`${segments.join("/")}${segments.length ? "/" : ""}`}
        after={chevron}
      >
        <a
          className="text-primary hover:underline"
          href={rawUrl(file.key, stamp)}
        >
          raw
        </a>
        {page.version && (
          <>
            <Dot />
            <a
              className="text-primary hover:underline"
              href={fileUrl(file.key)}
            >
              current
            </a>
          </>
        )}
        <Dot />
        {file.stable ? (
          <button
            type="button"
            className="cursor-pointer text-primary hover:underline"
            onClick={() => showTab("versions")}
          >
            versions {page.versions.length}
          </button>
        ) : (
          <span>no versions</span>
        )}
        <Dot />
      </Strip>
      {open && <Panel page={page} file={file} tab={tab} onTab={setTab} />}
    </div>
  )
}

// "2 versions newer than current" style note for a Version page.
function newerThan(page: FilePage): string {
  if (!page.version) return ""
  const index = page.versions.findIndex((v) => v.key === page.version!.key)
  const newer = index < 0 ? 0 : index
  return newer === 0
    ? "the previous version"
    : `${newer} version${newer === 1 ? "" : "s"} newer than this one`
}
