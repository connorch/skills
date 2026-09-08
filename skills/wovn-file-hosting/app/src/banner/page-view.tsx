import { DirectoryView } from "@/components/directory-view"
import { Preview } from "@/components/preview"
import type { Page } from "@/lib/types"
import { Banner } from "./banner"
import { Crumbs, Strip } from "./strip"

// An app page rendered by Start: a File Page (the Banner over a Preview) or
// a Directory Route page (the strip over the listing). HTML Files never get
// here; the host injects the Banner into them instead.
export function PageView({ page }: { page: Page }) {
  if (page.kind === "file") {
    return (
      <>
        <Banner page={page} />
        <Preview page={page} />
      </>
    )
  }
  const prefix = page.listing.prefix
  const segments = prefix.split("/").filter(Boolean)
  return (
    <>
      <Strip
        crumbs={<Crumbs segments={segments} tail={null} />}
        prefix={prefix}
      />
      <main className="mx-auto max-w-4xl px-4 py-2 font-mono text-[13px]">
        <DirectoryView prefix={prefix} initialListing={page.listing} />
      </main>
    </>
  )
}
