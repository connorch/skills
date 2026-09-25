import { hydrateRoot } from "react-dom/client"

import { BannerApp } from "@/banner/app"
import type { FilePage } from "@/lib/types"

// Hydrates the Banner the host injected into an HTML File (see
// src/host/inject.server.tsx): the markup lives in the <wovn-banner> shadow
// root and the Page in the JSON block next to it. Toasts get a light-DOM
// node of their own at the end of the body.
const host = document.querySelector("wovn-banner")
const shadow = host?.shadowRoot ?? null
const root = shadow?.getElementById("wovn-root")
const data = document.getElementById("wovn-page")?.textContent
if (root && data) {
  const page = JSON.parse(data) as FilePage
  const toasts = document.createElement("div")
  toasts.id = "wovn-toasts"
  document.body.appendChild(toasts)
  hydrateRoot(root, <BannerApp page={page} portal={shadow} toasts={toasts} />)
}
