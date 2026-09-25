import { useQuery } from "@tanstack/react-query"
import { Fragment, useState } from "react"

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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { fileUrl, parentUrl, versionUrl } from "@/lib/api"
import { formatSize, formatWhen } from "@/lib/format"
import {
  copyUrl,
  listingQuery,
  useDeleteFile,
  useSetVisibility,
  versionsQuery,
} from "@/lib/queries"
import { cn } from "@/lib/utils"
import type { FileEntry, Listing } from "@/lib/types"
import { versionStamp } from "@/lib/types"

// One directory level under `prefix` ("" = root), in classic-autoindex
// spirit - a dense table of directories then Files. The body of a Directory
// Route page and the files tab of the Banner, where `currentKey` marks the
// File the page is showing. Every link is a real link (the path is the
// state); deleting the current File leaves for its Directory Route.
export function DirectoryView({
  prefix,
  initialListing,
  currentKey,
}: {
  prefix: string
  initialListing?: Listing
  currentKey?: string
}) {
  const listing = useQuery({
    ...listingQuery(prefix),
    initialData: initialListing,
  })
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const remove = useDeleteFile((key) => {
    if (key === currentKey) window.location.assign(parentUrl(key))
  })

  if (listing.isError) {
    return (
      <div className="flex items-baseline gap-3 py-6 text-muted-foreground">
        <span>failed to load: {listing.error.message}</span>
        <Button variant="outline" size="sm" onClick={() => listing.refetch()}>
          retry
        </Button>
      </div>
    )
  }
  if (!listing.data) return <ListingSkeleton />

  const nameOf = (key: string) => key.slice(prefix.length)
  const { directories, files } = listing.data
  const parent = prefix === "" ? null : `/${prefix.replace(/[^/]+\/$/, "")}`

  return (
    <>
      {directories.length === 0 && files.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyTitle>empty directory</EmptyTitle>
            <EmptyDescription>no Files under this prefix</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <table className="w-full border-collapse">
          <ListingHead />
          <tbody>
            {parent !== null && (
              <tr className="border-b border-border/50">
                <td className="py-1 pr-4" colSpan={4}>
                  <a className="text-primary hover:underline" href={parent}>
                    ../
                  </a>
                </td>
              </tr>
            )}
            {directories.map((dir) => (
              <tr key={dir} className="border-b border-border/50">
                <td className="py-1 pr-4" colSpan={4}>
                  <a className="text-primary hover:underline" href={`/${dir}`}>
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
                current={file.key === currentKey}
                onDelete={() => setDeleting(file)}
              />
            ))}
          </tbody>
        </table>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting && nameOf(deleting.key)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The File and all its Versions are deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove.mutate(deleting.key)
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
  current,
  onDelete,
}: {
  file: FileEntry
  name: string
  current: boolean
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const flip = useSetVisibility()
  // Git context the File was uploaded with, shown as a native tooltip.
  const context = [file.project, file.branch].filter(Boolean).join(" · ")

  return (
    <>
      <tr
        className={cn("border-b border-border/50", current && "bg-accent/60")}
      >
        <td className="py-1 pr-4">
          <span className="flex items-center gap-1.5">
            <a
              className={cn(
                "truncate hover:underline",
                current && "font-semibold text-primary"
              )}
              href={fileUrl(file.key)}
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
                  onClick={() =>
                    flip.mutate({
                      key: file.key,
                      visibility:
                        file.visibility === "public" ? "private" : "public",
                    })
                  }
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
          <Action label="copy" onClick={() => copyUrl(fileUrl(file.key))} />
          {file.stable && (
            <>
              {" · "}
              <Action
                label="history"
                onClick={() => setExpanded((open) => !open)}
              />
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
    <button
      type="button"
      className="cursor-pointer text-primary hover:underline"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

// Inline expansion under a stable File: its Versions, newest first, each
// linking to its File Page.
function VersionRows({ fileKey }: { fileKey: string }) {
  const versions = useQuery(versionsQuery(fileKey))

  const note = (text: string) => (
    <tr className="border-b border-border/50">
      <td className="py-1 pr-4 pl-6 text-muted-foreground" colSpan={4}>
        {text}
      </td>
    </tr>
  )
  if (versions.isError) return note("failed to load history")
  if (!versions.data) {
    return (
      <tr className="border-b border-border/50">
        <td className="py-1 pr-4 pl-6" colSpan={4}>
          <Skeleton className="h-3 w-48" />
        </td>
      </tr>
    )
  }
  if (versions.data.versions.length === 0) return note("no previous versions")
  return (
    <Fragment>
      {versions.data.versions.map((version) => (
        <tr key={version.key} className="border-b border-border/50">
          <td className="py-1 pr-4 pl-6">
            <a
              className="text-muted-foreground hover:underline"
              href={versionUrl(fileKey, versionStamp(version.key))}
            >
              {versionStamp(version.key)}
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
