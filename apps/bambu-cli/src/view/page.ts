// Fill the built viewer template (apps/bambu-viewer) with a Review and a GLB,
// producing one self-contained Review Page (docs/adr/0002).

import type { Review } from "bambu-viewer/src/review.ts";
import { template } from "./template.ts";

export type { Review };

export function renderReviewPage(review: Review, glb: Uint8Array): string {
  // "</script" inside the JSON would end the data block early.
  const json = JSON.stringify(review).replaceAll("<", "\\u003c");
  return fill(fill(template(), "review", json), "model", Buffer.from(glb).toString("base64"));
}

// Replace the body of the template's `<script id="...">` data block. The
// viewer's own code mentions the placeholder strings too, so match the tag
// rather than the placeholder.
function fill(page: string, id: string, content: string): string {
  const block = new RegExp(`(<script id="${id}"[^>]*>)[^<]*(</script>)`);
  if (!block.test(page)) {
    throw new Error(`viewer template has no #${id} script; rebuild apps/bambu-viewer`);
  }
  return page.replace(block, (_, open: string, close: string) => `${open}${content}${close}`);
}
