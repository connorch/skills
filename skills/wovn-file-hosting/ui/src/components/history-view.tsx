import { useEffect, useState } from "react"

import { fetchVersions, versionUrl, type Versions } from "@/lib/api"
import { formatSize, formatWhen } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

// The /<key>/archive view: a File's current state plus its Versions, newest
// first. Version links go through the /<key>/archive/<stamp> alias URLs.
export function HistoryView({ fileKey }: { fileKey: string }) {
  const [history, setHistory] = useState<Versions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Remounted per path (key={path} in App), so this only re-runs on retry;
  // the retry handler clears the error before bumping `attempt`.
  useEffect(() => {
    let cancelled = false
    fetchVersions(fileKey).then(
      (result) => {
        if (!cancelled) setHistory(result)
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [fileKey, attempt])

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

  if (!history) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-3 w-60" />
      </div>
    )
  }

  if (!history.current && history.versions.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>nothing here</EmptyTitle>
          <EmptyDescription>{fileKey} has no current state and no Versions</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

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
        {history.current && (
          <tr className="border-b border-border/50">
            <td className="py-1 pr-4">
              <a className="hover:underline" href={`/${history.current.key}`} target="_blank" rel="noreferrer">
                current
              </a>
            </td>
            <td className="py-1 pr-4 text-right whitespace-nowrap text-muted-foreground">
              {formatSize(history.current.size)}
            </td>
            <td className="py-1 text-right whitespace-nowrap text-muted-foreground">
              {formatWhen(history.current.uploaded)}
            </td>
          </tr>
        )}
        {history.versions.map((version) => (
          <tr key={version.key} className="border-b border-border/50">
            <td className="py-1 pr-4">
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
            <td className="py-1 text-right whitespace-nowrap text-muted-foreground">
              {formatWhen(version.uploaded)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
