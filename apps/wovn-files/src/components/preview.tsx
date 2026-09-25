import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { rawUrl } from "@/lib/api"
import { formatSize, formatStamp } from "@/lib/format"
import { textQuery } from "@/lib/queries"
import type { FilePage } from "@/lib/types"
import { versionStamp } from "@/lib/types"

// Text this large is not pulled into the DOM; the File gets the download
// card instead (docs/adr/0003).
const TEXT_LIMIT = 2 * 1024 * 1024

type Kind = "image" | "video" | "audio" | "frame" | "text" | "none"

// How the browser can show a content type (docs/adr/0003): native elements
// for media, an iframe for what the browser renders as a document, fetched
// text for text types (browsers download markdown, CSV, and YAML in a frame),
// nothing for the rest.
function kindOf(contentType: string, size: number): Kind {
  const type = contentType.split(";")[0].trim().toLowerCase()
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "application/pdf" || type === "image/svg+xml") return "frame"
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/yaml" ||
    type === "application/x-yaml" ||
    type === "application/xml"
  ) {
    return size <= TEXT_LIMIT ? "text" : "none"
  }
  return "none"
}

// The Preview of a non-HTML File Page: the File (or the Version the page
// shows) rendered from its Raw URL.
export function Preview({ page }: { page: FilePage }) {
  const shown = page.version ?? page.file
  const stamp = page.version ? versionStamp(page.version.key) : undefined
  const src = rawUrl(page.file.key, stamp)
  const name = page.file.key.split("/").pop() ?? page.file.key

  switch (kindOf(shown.contentType, shown.size)) {
    case "image":
      return (
        <div className="flex justify-center p-4">
          <a href={src} className="max-w-full">
            <img
              src={src}
              alt={name}
              className="max-h-[calc(100vh-6rem)] max-w-full"
            />
          </a>
        </div>
      )
    case "video":
      return (
        <div className="flex justify-center p-4">
          <video
            src={src}
            controls
            className="max-h-[calc(100vh-6rem)] max-w-full"
          />
        </div>
      )
    case "audio":
      return (
        <div className="p-4">
          <audio src={src} controls className="w-full" />
        </div>
      )
    case "frame":
      return (
        <iframe
          src={src}
          title={name}
          className="h-[calc(100vh-2rem)] w-full border-0"
        />
      )
    case "text":
      return <TextPreview src={src} />
    case "none":
      return <DownloadCard page={page} src={src} />
  }
}

function TextPreview({ src }: { src: string }) {
  const text = useQuery(textQuery(src))
  if (text.isError) {
    return (
      <div className="flex items-baseline gap-3 p-4 text-muted-foreground">
        <span>failed to load: {text.error.message}</span>
        <Button variant="outline" size="sm" onClick={() => text.refetch()}>
          retry
        </Button>
      </div>
    )
  }
  if (text.data === undefined)
    return <div className="p-4 text-muted-foreground">loading</div>
  return (
    <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
      {text.data}
    </pre>
  )
}

// Types with no browser rendering (and text over the limit): the File's
// facts and a download link.
function DownloadCard({ page, src }: { page: FilePage; src: string }) {
  const shown = page.version ?? page.file
  const name = page.file.key.split("/").pop() ?? page.file.key
  return (
    <div className="px-4 py-8 font-mono text-[12.5px] text-muted-foreground">
      <div>
        <span className="font-medium text-foreground">{name}</span>
        {" · "}
        {formatSize(shown.size)}
        {" · "}
        {shown.contentType}
        {" · "}
        {page.version ? "private" : page.file.visibility}
        {" · uploaded "}
        {formatStamp(shown.uploaded)}
        {page.file.project && ` · project ${page.file.project}`}
      </div>
      <div className="pt-1">
        <a className="text-primary hover:underline" href={src} download={name}>
          download
        </a>
      </div>
    </div>
  )
}
