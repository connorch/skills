import { useState } from "react"

import { DirectoryView } from "@/components/directory-view"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { fileUrl, parentUrl, rawUrl, versionUrl } from "@/lib/api"
import { formatSize, formatStamp, formatWhen } from "@/lib/format"
import { copyUrl, useDeleteFile } from "@/lib/queries"
import type { FileMeta, FilePage } from "@/lib/types"
import { versionStamp } from "@/lib/types"
import { cn } from "@/lib/utils"
import { VisibilityBadge } from "./visibility-badge"

export type Tab = "files" | "versions" | "details"

// The Banner's expanded panel: one full-width pane at a time (mocks, variant
// C). files is the directory listing with the current File marked; versions
// links to the File's Versions; details holds the facts and the management
// actions.
export function Panel({
  page,
  file,
  tab,
  onTab,
}: {
  page: FilePage
  // The current File, live from the query cache (visibility may have flipped).
  file: FileMeta
  tab: Tab
  onTab: (tab: Tab) => void
}) {
  const prefix = page.file.key.replace(/[^/]*$/, "")
  const tabs: { id: Tab; label: string }[] = [
    { id: "files", label: "files" },
    { id: "versions", label: `versions ${page.versions.length}` },
    { id: "details", label: "details" },
  ]
  return (
    <div className="border-b border-border bg-background font-mono text-[12.5px]">
      <div className="flex border-b border-border" role="tablist">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              "-mb-px cursor-pointer border-b-2 px-3 py-1 text-muted-foreground hover:text-foreground",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent"
            )}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-2.5 py-1.5">
        {tab === "files" && (
          <DirectoryView prefix={prefix} currentKey={page.file.key} />
        )}
        {tab === "versions" && <VersionsPane page={page} />}
        {tab === "details" && <DetailsPane page={page} file={file} />}
      </div>
    </div>
  )
}

// The current File then its Versions, newest first, each a link to its File
// Page. The row the page is showing is marked.
function VersionsPane({ page }: { page: FilePage }) {
  const showing = page.version?.key ?? page.file.key
  const row = (
    href: string,
    label: string,
    size: number,
    uploaded: string,
    current: boolean
  ) => (
    <tr key={href} className="border-b border-border/50">
      <td className="py-1 pr-4">
        <a
          className={cn(
            "hover:underline",
            current ? "font-semibold text-primary" : "text-muted-foreground"
          )}
          href={href}
        >
          {label}
        </a>
      </td>
      <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
        {formatSize(size)}
      </td>
      <td className="py-1 text-right whitespace-nowrap text-muted-foreground">
        {formatWhen(uploaded)}
      </td>
    </tr>
  )
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-border text-left text-muted-foreground">
          <th className="py-1.5 pr-4 font-medium">version</th>
          <th className="py-1.5 pr-4 text-right font-medium">size</th>
          <th className="py-1.5 text-right font-medium">uploaded</th>
        </tr>
      </thead>
      <tbody>
        {row(
          fileUrl(page.file.key),
          "current",
          page.file.size,
          page.file.uploaded,
          showing === page.file.key
        )}
        {page.versions.map((version) =>
          row(
            versionUrl(page.file.key, versionStamp(version.key)),
            formatStamp(version.uploaded),
            version.size,
            version.uploaded,
            showing === version.key
          )
        )}
        {page.versions.length === 0 && (
          <tr>
            <td className="py-2 text-muted-foreground" colSpan={3}>
              {page.file.stable
                ? "no previous versions"
                : "generated key, never overwritten"}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

// The File's facts plus copy, download, and delete. When the page shows a
// Version, the size, type, and uploaded rows describe that Version.
function DetailsPane({ page, file }: { page: FilePage; file: FileMeta }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteFile((key) => window.location.assign(parentUrl(key)))
  const shown = page.version ?? file
  const stamp = page.version ? versionStamp(page.version.key) : undefined
  const name = file.key.split("/").pop() ?? file.key
  const rows: [string, React.ReactNode][] = [
    ["key", file.key],
    ...(page.version ? [["version", stamp] as [string, React.ReactNode]] : []),
    [
      "visibility",
      <VisibilityBadge file={file} readOnly={page.version !== null} />,
    ],
    ["size", `${formatSize(shown.size)}, ${shown.contentType}`],
    ["uploaded", formatStamp(shown.uploaded)],
    [
      "stable path",
      file.stable
        ? `yes, ${page.versions.length} version${page.versions.length === 1 ? "" : "s"}`
        : "no, generated key",
    ],
    ...(file.project
      ? [["project", file.project] as [string, React.ReactNode]]
      : []),
    ...(file.branch
      ? [["branch", file.branch] as [string, React.ReactNode]]
      : []),
    ...(file.worktree
      ? [["worktree", file.worktree] as [string, React.ReactNode]]
      : []),
    ...(file.dir ? [["dir", file.dir] as [string, React.ReactNode]] : []),
  ]
  return (
    <>
      <table className="border-collapse">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-border/50">
              <td className="py-1 pr-6 whitespace-nowrap text-muted-foreground">
                {label}
              </td>
              <td className="py-1 break-all">{value}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1 pr-6 text-muted-foreground">actions</td>
            <td className="py-1 whitespace-nowrap">
              <button
                type="button"
                className="cursor-pointer text-primary hover:underline"
                onClick={() =>
                  copyUrl(
                    page.version
                      ? versionUrl(file.key, stamp!)
                      : fileUrl(file.key)
                  )
                }
              >
                copy url
              </button>
              {" · "}
              <a
                className="text-primary hover:underline"
                href={rawUrl(file.key, stamp)}
                download={name}
              >
                download
              </a>
              {" · "}
              <button
                type="button"
                className="cursor-pointer text-destructive hover:underline"
                onClick={() => setConfirming(true)}
              >
                delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The File and all its Versions are deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate(file.key)
                setConfirming(false)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
