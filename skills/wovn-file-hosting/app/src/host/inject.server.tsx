// The Banner for HTML Files (docs/adr/0003): the File stays the browser's
// main document and the Banner is streamed into the top of its <body> as
// declarative Shadow DOM - the server-rendered Banner and the app stylesheet
// inside <template shadowrootmode="open">, the Page as JSON, and the one
// module script that hydrates it. The File's own head, styles, scripts, and
// links are untouched.
import { renderToString } from "react-dom/server"

import { BannerApp } from "@/banner/app"
import type { FilePage } from "@/lib/types"
import stylesheet from "@/styles.css?inline"

export const BANNER_HOST = "wovn-banner"
export const BANNER_ROOT_ID = "wovn-root"
export const BANNER_PAGE_ID = "wovn-page"
export const BANNER_SCRIPT = "/_/banner.js"

// Tailwind registers its `--tw-*` variables with @property, and browsers
// ignore @property inside a shadow tree; registered once in the document
// they apply to shadow trees too, so the registrations ride along in the
// light DOM. Computed once per isolate: the stylesheet is a build constant.
const PROPERTY_RULES =
  stylesheet.match(/@property[^{]+\{[^}]*\}/g)?.join("") ?? ""

export function injectBanner(object: R2ObjectBody, page: FilePage): Response {
  const markup = renderToString(<BannerApp page={page} />)
  // "</script" inside the JSON would end the data block early.
  const json = JSON.stringify(page).replace(/</g, "\\u003c")
  const fragment =
    `<style>${PROPERTY_RULES}</style>` +
    `<${BANNER_HOST}><template shadowrootmode="open"><style>${stylesheet}</style>` +
    `<div id="${BANNER_ROOT_ID}">${markup}</div></template></${BANNER_HOST}>` +
    `<script type="application/json" id="${BANNER_PAGE_ID}">${json}</script>` +
    `<script type="module" src="${BANNER_SCRIPT}"></script>`

  let injected = false
  const rewritten = new HTMLRewriter()
    .on("body", {
      element(body) {
        if (injected) return
        injected = true
        body.prepend(fragment, { html: true })
      },
    })
    .onDocument({
      // A File with no <body> tag at all still gets the Banner, at the end.
      end(end) {
        if (!injected) end.append(fragment, { html: true })
      },
    })
    .transform(new Response(object.body))

  return new Response(rewritten.body, {
    headers: {
      "content-type":
        object.httpMetadata?.contentType ?? "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  })
}
