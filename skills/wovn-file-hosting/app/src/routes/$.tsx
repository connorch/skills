import { createFileRoute } from "@tanstack/react-router"

import { PageView } from "@/banner/page-view"
import type { Page } from "@/lib/types"

// The one content route: every authenticated app page. The host resolved the
// Page (src/host/index.server.ts) before Start ran, so the loader only
// returns it; there is no client-side navigation between pages (every link
// is a real link, so the path is the state), which is why the loader never
// runs on the client.
export const Route = createFileRoute("/$")({
  loader: ({ serverContext }) => {
    const page = serverContext?.page
    if (!page)
      throw new Error(
        "no page for this request; navigate with a full page load"
      )
    return page
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? titleOf(loaderData) : "files.wovn.org" }],
  }),
  component: PageRoute,
})

function PageRoute() {
  return <PageView page={Route.useLoaderData()} />
}

function titleOf(page: Page): string {
  const target = page.kind === "file" ? page.file.key : page.listing.prefix
  return target ? `files.wovn.org/${target}` : "files.wovn.org"
}
