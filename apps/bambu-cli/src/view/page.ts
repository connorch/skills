// Fill the built viewer template (apps/bambu-viewer) with a Review and a GLB,
// producing one self-contained Review Page (docs/adr/0002).

import template from "bambu-viewer/dist/index.html?raw";
import { PLACEHOLDER_MODEL, PLACEHOLDER_REVIEW, type Review } from "bambu-viewer/src/review.ts";

export type { Review };

export function renderReviewPage(review: Review, glb: Uint8Array): string {
  // "</script" inside the JSON would end the data block early.
  const json = JSON.stringify(review).replaceAll("<", "\\u003c");
  const page = template
    .replace(PLACEHOLDER_REVIEW, () => json)
    .replace(PLACEHOLDER_MODEL, () => Buffer.from(glb).toString("base64"));
  if (page.includes(PLACEHOLDER_REVIEW) || page.includes(PLACEHOLDER_MODEL)) {
    throw new Error("viewer template placeholders not found; rebuild apps/bambu-viewer");
  }
  return page;
}
