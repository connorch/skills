import { createRoot, hydrateRoot } from "react-dom/client";

import { BannerApp } from "@/banner/app";
import { Toaster } from "@/components/ui/sonner";
import type { FilePage } from "@/lib/types";

// Hydrates the Banner the host injected into an HTML File (see
// src/host/inject.server.tsx): the markup lives in the <wovn-banner> shadow
// root and the Page in the JSON block next to it. Toasts get a light-DOM
// node and a React root of their own at the end of the body: sonner styles
// itself through the document head, and a client-only node inside the
// hydrated tree would not match the server markup. sonner's toast() reaches
// the toaster through its global store, so the roots need no wiring.
const host = document.querySelector("wovn-banner");
const shadow = host?.shadowRoot ?? null;
const root = shadow?.getElementById("wovn-root");
const data = document.getElementById("wovn-page")?.textContent;
if (root && data) {
  const page = JSON.parse(data) as FilePage;
  const toasts = document.createElement("div");
  toasts.id = "wovn-toasts";
  document.body.appendChild(toasts);
  // Level with the fixed Banner's z-index (styles.css :host) and later in
  // the document, so toasts paint above an open Finder panel.
  createRoot(toasts).render(<Toaster style={{ zIndex: 2147483647 }} />);
  hydrateRoot(root, <BannerApp page={page} portal={shadow} />);
}
