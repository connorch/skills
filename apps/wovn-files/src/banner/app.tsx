import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { createPortal } from "react-dom"

import { PortalContainerProvider } from "@/components/portal-container"
import { Toaster } from "@/components/ui/sonner"
import type { FilePage } from "@/lib/types"
import { Banner } from "./banner"

// The Banner as mounted inside an HTML File (src/host/inject.server.tsx and
// src/banner.tsx): its own query client, portals pointed at the shadow root,
// and the toaster in a light-DOM node because sonner styles itself through
// the document head. Rendered to a string on the server (no portal, no
// toaster) and hydrated in the browser.
export function BannerApp({
  page,
  portal = null,
  toasts = null,
}: {
  page: FilePage
  portal?: ShadowRoot | null
  toasts?: HTMLElement | null
}) {
  const [queryClient] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={queryClient}>
      <PortalContainerProvider value={portal}>
        <div className="bg-background font-mono text-[12.5px] leading-normal text-foreground antialiased">
          <Banner page={page} />
        </div>
      </PortalContainerProvider>
      {toasts && createPortal(<Toaster />, toasts)}
    </QueryClientProvider>
  )
}
