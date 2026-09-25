/// <reference types="vite/client" />
import type { QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import type { ReactNode } from "react"

import { Toaster } from "@/components/ui/sonner"

import stylesheet from "@/styles.css?url"

// Every app page (Directory Route pages, File Pages with a Preview) shares
// this shell. The Banner and the page body render from the catch-all route.
export interface RouterContext {
  queryClient: QueryClient
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext x='1' y='13' font-family='monospace' font-size='14' fill='%2390CAF9'%3Ew%3C/text%3E%3C/svg%3E"

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "files.wovn.org" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", href: FAVICON },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}
