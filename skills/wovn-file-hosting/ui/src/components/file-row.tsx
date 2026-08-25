import { useState } from "react"
import { CopyIcon, HistoryIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  deleteFile,
  fileUrl,
  historyOf,
  setVisibility,
  type BrowseFile,
  type HistoryVersion,
} from "@/lib/api"
import { formatSize, formatTime } from "@/lib/format"

async function copyUrl(url: string) {
  await navigator.clipboard.writeText(url)
  toast("URL copied")
}

// One file in the listing: name (linked to the served URL), size, upload
// time, visibility badge (click to flip), and history / copy / delete
// actions. History expands lazily into version rows below this one.
export function FileRow({
  file,
  name,
  onDeleted,
}: {
  file: BrowseFile
  name: string
  onDeleted: () => void
}) {
  // Visibility is the row's only mutable server state; track it locally so a
  // flip does not force a whole-listing reload.
  const [visibility, setVisibilityState] = useState(file.visibility)
  const [flipping, setFlipping] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const url = fileUrl(file.key)
  const context = [file.project, file.branch].filter(Boolean).join(" · ")

  async function flip() {
    const next = visibility === "public" ? "private" : "public"
    setFlipping(true)
    try {
      await setVisibility(file.key, next)
      setVisibilityState(next)
      toast(`${name} is now ${next}`)
    } catch (error) {
      toast.error(`Visibility change failed: ${error}`)
    } finally {
      setFlipping(false)
    }
  }

  function toggleHistory() {
    const open = !expanded
    setExpanded(open)
    if (open && versions === null && historyError === null) {
      historyOf(file.key)
        .then((history) => setVersions(history.versions))
        .catch((error) => setHistoryError(String(error)))
    }
  }

  async function remove() {
    setConfirmOpen(false)
    try {
      await deleteFile(file.key)
      toast(`Deleted ${name}`)
      onDeleted()
    } catch (error) {
      toast.error(`Delete failed: ${error}`)
    }
  }

  const nameLink = (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="truncate font-mono text-[13px] hover:underline"
    >
      {name}
    </a>
  )

  return (
    <>
      <TableRow>
        <TableCell className="max-w-0 py-1.5">
          <div className="flex items-center gap-2">
            {context ? (
              <Tooltip>
                <TooltipTrigger render={nameLink} />
                <TooltipContent>{context}</TooltipContent>
              </Tooltip>
            ) : (
              nameLink
            )}
            {file.stable && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                stable
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="py-1.5 text-right font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
          {formatSize(file.size)}
        </TableCell>
        <TableCell className="py-1.5 text-xs whitespace-nowrap text-muted-foreground">
          {formatTime(file.uploaded)}
        </TableCell>
        <TableCell className="py-1.5">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={flip}
              disabled={flipping}
              title={`make ${visibility === "public" ? "private" : "public"}`}
              className="cursor-pointer disabled:opacity-50"
            >
              <Badge
                variant={visibility === "public" ? "default" : "secondary"}
                className="h-4 px-1.5 text-[10px]"
              >
                {visibility}
              </Badge>
            </button>
            {file.stable && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="History"
                title="history"
                onClick={toggleHistory}
              >
                <HistoryIcon />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy URL"
              title="copy URL"
              onClick={() => copyUrl(url)}
            >
              <CopyIcon />
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Delete"
                    title="delete"
                  />
                }
              >
                <Trash2Icon />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Removes <span className="font-mono">{file.key}</span> and
                    its whole archived version history. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TableCell>
      </TableRow>
      {expanded &&
        (historyError !== null ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="py-1.5 pl-8 text-xs text-destructive">
              {historyError}
            </TableCell>
          </TableRow>
        ) : versions === null ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="py-1.5 pl-8 text-xs text-muted-foreground">
              Loading versions
            </TableCell>
          </TableRow>
        ) : versions.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="py-1.5 pl-8 text-xs text-muted-foreground">
              No archived versions
            </TableCell>
          </TableRow>
        ) : (
          versions.map((version) => (
            <TableRow key={version.key} className="bg-muted/40 hover:bg-muted/40">
              <TableCell className="max-w-0 py-1 pl-8">
                <a
                  href={fileUrl(version.key)}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-xs text-muted-foreground hover:underline"
                >
                  {version.key.split("/").pop()}
                </a>
              </TableCell>
              <TableCell className="py-1 text-right font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
                {formatSize(version.size)}
              </TableCell>
              <TableCell className="py-1 text-xs whitespace-nowrap text-muted-foreground">
                {formatTime(version.uploaded)}
              </TableCell>
              <TableCell className="py-1">
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Copy version URL"
                    title="copy URL"
                    onClick={() => copyUrl(fileUrl(version.key))}
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))
        ))}
    </>
  )
}
