import { QueryClient } from "@tanstack/react-query"
import { createRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"

import type { Page } from "@/lib/types"
import { routeTree } from "./routeTree.gen"

// The Page the host resolved for this request (src/server.ts), which the
// catch-all route's loader returns. Only present on the server.
export interface RequestContext {
  page?: Page
}

export function getRouter() {
  const queryClient = new QueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    // A trailing slash always means a Directory Route (ADR 0002); the router
    // must not normalise it away.
    trailingSlash: "preserve",
    scrollRestoration: true,
  })
  // Dehydrates the query cache into the SSR stream so the client starts with
  // whatever the loader prefetched.
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

// The request context src/server.ts passes to Start.
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: RequestContext }
  }
}
