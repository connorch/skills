import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { PortalContainerProvider } from "@/components/portal-container";
import type { FilePage } from "@/lib/types";
import { Banner } from "./banner";

// The Banner as mounted inside an HTML File (src/host/inject.server.tsx and
// src/banner.tsx): its own query client and portals pointed at the shadow
// root. Rendered to a string on the server and hydrated in the browser, so
// the tree must be identical on both sides; the toaster lives in a separate
// client-only root (src/banner.tsx).
export function BannerApp({ page, portal = null }: { page: FilePage; portal?: ShadowRoot | null }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <PortalContainerProvider value={portal}>
        <div className="bg-background font-ui text-[13px] leading-normal text-foreground antialiased">
          <Banner page={page} />
        </div>
      </PortalContainerProvider>
    </QueryClientProvider>
  );
}
