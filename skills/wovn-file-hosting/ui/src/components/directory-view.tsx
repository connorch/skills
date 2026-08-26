import { Fragment, useEffect, useState } from "react"
import { toast } from "sonner"

import {
  deleteFile,
  fetchListing,
  fetchVersions,
  setVisibility,
  versionUrl,
  type FileEntry,
  type Listing,
  type Version,
} from "@/lib/api"
import { formatSize, formatWhen, navClick } from "@/lib/format"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

// The Directory Route view: one directory level under `prefix` ("" = root),
// in classic-autoindex spirit - a dense table of directories then Files.
export function DirectoryView({
  prefix,
  filter,
  navigate,
}: {
  prefix: string
  filter: string
  navigate: (to: string) => void
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [deleting, setDeleting] = useState<FileEntry | null>(null)

  // The view is remounted per path (key={path} in App), so this only re-runs
  // on retry; the retry handler clears the error before bumping `attempt`.
  useEffect(() => {
    let cancelled = false
    fetchListing(prefix).then(
      (result) => {
        if (!cancelled) setListing(result)
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [prefix, attempt])

  if (error) {
    return (
      <div className="flex items-baseline gap-3 py-6 text-muted-foreground">
        <span>failed to load: {error}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null)
            setAttempt((n) => n + 1)
          }}
        >
          retry
        </Button>
      </div>
    )
  }

  if (!listing) return <ListingSkeleton />

  const needle = filter.trim().toLowerCase()
  const nameOf = (key: string) => key.slice(prefix.length)
  const directories = listing.directories.filter((d) => nameOf(d).toLowerCase().includes(needle))
  const files = listing.files.filter((f) => nameOf(f.key).toLowerCase().includes(needle))
  const parent = prefix === "" ? null : `/${prefix.replace(/[^/]+\/$/, "")}`

  const removeFile = (key: string) =>
    setListing((current) =>
      current ? { ...current, files: current.files.filter((f) => f.key !== key) } : current
    )
  const replaceFile = (entry: FileEntry) =>
    setListing((current) =>
      current
        ? { ...current, files: current.files.map((f) => (f.key === entry.key ? entry : f)) }
        : current
    )

  return (
    <>
      {directories.length === 0 && files.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyTitle>{needle ? "no matches" : "empty directory"}</EmptyTitle>
            <EmptyDescription>
              {needle ? `nothing here matches "${filter.trim()}"` : "no Files under this prefix"}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <table className="w-full border-collapse">
          <ListingHead />
          <tbody>
            {parent !== null && (
              <tr className="border-b border-border/50">
                <td className="py-1 pr-4" colSpan={4}>
                  <a className="text-primary hover:underline" href={parent} onClick={navClick(navigate, parent)}>
                    ../
                  </a>
                </td>
              </tr>
            )}
            {directories.map((dir) => (
              <tr key={dir} className="border-b border-border/50">
                <td className="py-1 pr-4" colSpan={4}>
                  <a
                    className="text-primary hover:underline"
                    href={`/${dir}`}
                    onClick={navClick(navigate, `/${dir}`)}
                  >
                    {nameOf(dir)}
                  </a>
                </td>
              </tr>
            ))}
            {files.map((file) => (
              <FileRow
                key={file.key}
                file={file}
                name={nameOf(file.key)}
                onFlip={replaceFile}
                onDelete={() => setDeleting(file)}
              />
            ))}
          </tbody>
        </table>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting && nameOf(deleting.key)}?</AlertDialogTitle>
            <AlertDialogDescription>
              The File and all its Versions are deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return
                const target = deleting
                deleteFile(target.key).then(
                  ({ deleted }) => {
                    removeFile(target.key)
                    toast.success(`deleted ${target.key} (${deleted.length} object${deleted.length === 1 ? "" : "s"})`)
                  },
                  (cause: unknown) =>
                    toast.error(cause instanceof Error ? cause.message : "delete failed")
                )
                setDeleting(null)
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

function ListingHead() {
  return (
    <thead>
      <tr className="border-b border-border text-left text-muted-foreground">
        <th className="py-1.5 pr-4 font-medium">name</th>
        <th className="py-1.5 pr-4 text-right font-medium">size</th>
        <th className="py-1.5 pr-4 text-right font-medium">uploaded</th>
        <th className="py-1.5 font-medium" />
      </tr>
    </thead>
  )
}

function ListingSkeleton() {
  return (
    <table className="w-full border-collapse">
      <ListingHead />
      <tbody>
        {[24, 40, 32, 28, 36].map((width, row) => (
          <tr key={row} className="border-b border-border/50">
            <td className="py-2 pr-4">
              <Skeleton className="h-3" style={{ width: `${width * 4}px` }} />
            </td>
            <td className="py-2 pr-4">
              <Skeleton className="ml-auto h-3 w-12" />
            </td>
            <td className="py-2 pr-4">
              <Skeleton className="ml-auto h-3 w-12" />
            </td>
            <td className="py-2">
              <Skeleton className="h-3 w-20" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FileRow({
  file,
  name,
  onFlip,
  onDelete,
}: {
  file: FileEntry
  name: string
  onFlip: (entry: FileEntry) => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Git context the File was uploaded with, shown as a native tooltip.
  const context = [file.project, file.branch].filter(Boolean).join(" · ")

  const flip = () => {
    const next = file.visibility === "public" ? "private" : "public"
    setVisibility(file.key, next).then(
      (updated) => {
        onFlip({ ...file, ...updated })
        toast.success(`${name} is now ${updated.visibility}`)
      },
      (cause: unknown) => toast.error(cause instanceof Error ? cause.message : "flip failed")
    )
  }

  const copy = () => {
    navigator.clipboard.writeText(`${window.location.origin}/${file.key}`).then(
      () => toast.success("URL copied"),
      () => toast.error("copy failed")
    )
  }

  return (
    <>
      <tr className="border-b border-border/50">
        <td className="py-1 pr-4">
          <span className="flex items-center gap-1.5">
            <a
              className="truncate hover:underline"
              href={`/${file.key}`}
              target="_blank"
              rel="noreferrer"
              title={context || undefined}
            >
              {name}
            </a>
            <Badge
              variant={file.visibility === "public" ? "secondary" : "outline"}
              render={
                <button
                  type="button"
                  className="cursor-pointer"
                  title="click to flip visibility"
                  onClick={flip}
                />
              }
            >
              {file.visibility}
            </Badge>
            {file.stable && <Badge variant="outline">stable</Badge>}
          </span>
        </td>
        <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
          {formatSize(file.size)}
        </td>
        <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
          {formatWhen(file.uploaded)}
        </td>
        <td className="py-1 whitespace-nowrap text-muted-foreground">
          <Action label="copy" onClick={copy} />
          {file.stable && (
            <>
              {" · "}
              <Action label="history" onClick={() => setExpanded((open) => !open)} />
            </>
          )}
          {" · "}
          <Action label="delete" onClick={onDelete} />
        </td>
      </tr>
      {expanded && <VersionRows fileKey={file.key} />}
    </>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="cursor-pointer text-primary hover:underline" onClick={onClick}>
      {label}
    </button>
  )
}

// Inline expansion under a stable File: its Versions, newest first, each
// linking to the /<key>/archive/<stamp> alias URL.
function VersionRows({ fileKey }: { fileKey: string }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchVersions(fileKey).then(
      (result) => {
        if (!cancelled) setVersions(result.versions)
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [fileKey])

  if (failed) {
    return (
      <tr className="border-b border-border/50">
        <td className="py-1 pr-4 pl-6 text-muted-foreground" colSpan={4}>
          failed to load history
        </td>
      </tr>
    )
  }
  if (versions === null) {
    return (
      <tr className="border-b border-border/50">
        <td className="py-1 pr-4 pl-6" colSpan={4}>
          <Skeleton className="h-3 w-48" />
        </td>
      </tr>
    )
  }
  if (versions.length === 0) {
    return (
      <tr className="border-b border-border/50">
        <td className="py-1 pr-4 pl-6 text-muted-foreground" colSpan={4}>
          no previous versions
        </td>
      </tr>
    )
  }
  return (
    <Fragment>
      {versions.map((version) => (
        <tr key={version.key} className="border-b border-border/50">
          <td className="py-1 pr-4 pl-6">
            <a
              className="text-muted-foreground hover:underline"
              href={versionUrl(version.key)}
              target="_blank"
              rel="noreferrer"
            >
              {version.key.split("/").pop()}
            </a>
          </td>
          <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
            {formatSize(version.size)}
          </td>
          <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
            {formatWhen(version.uploaded)}
          </td>
          <td className="py-1" />
        </tr>
      ))}
    </Fragment>
  )
}
