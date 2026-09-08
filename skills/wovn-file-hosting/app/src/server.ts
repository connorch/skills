// The Worker's fetch entry (docs/adr/0004). The file host runs first and
// answers everything that is not an app page: Raw bytes, uploads, /api,
// /login, assets, redirects, and HTML Files with the Banner injected. Only
// an authenticated app page reaches the Start handler, with the resolved
// Page as request context, so routes and loaders never check auth.
import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"

import { host } from "@/host/index.server"

const start = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request) {
    const result = await host(request)
    if (result instanceof Response) return result
    const response = await start(request, { context: { page: result.page } })
    // App pages are one of two representations of the same URL (ADR 0003)
    // and personal to the session: never cached.
    const headers = new Headers(response.headers)
    headers.set("cache-control", "private, no-store")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
})
