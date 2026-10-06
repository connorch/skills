import { describe, expect, it } from "vite-plus/test";
import { renderReviewPage } from "./page.ts";
import { PLACEHOLDER_MODEL, PLACEHOLDER_REVIEW } from "bambu-viewer/src/review.ts";

// The shape of apps/bambu-viewer/index.html after the build: the viewer code
// (which mentions the placeholders) comes before the two data blocks.
const TEMPLATE = `<html><head><script>if (t !== "${PLACEHOLDER_REVIEW}") x()</script></head><body><script id="review" type="application/json">${PLACEHOLDER_REVIEW}</script><script id="model" type="text/plain">${PLACEHOLDER_MODEL}</script></body></html>`;

describe("renderReviewPage", () => {
  it("fills the data blocks even though the viewer code mentions the placeholders", () => {
    const page = renderReviewPage(
      {
        job: "j",
        title: "</script><b>",
        model: { file: "m.stl", triangles: 1, size: [1, 2, 3] },
        printer: { name: "P1S", plate: [256, 256, 256] },
      },
      new Uint8Array([103, 108, 84, 70]),
      TEMPLATE,
    );
    expect(page).toContain('<script id="model" type="text/plain">Z2xURg==</script>');
    expect(page).toMatch(/<script id="review" type="application\/json">\{"job":"j".*\}<\/script>/);
    expect(page).not.toContain('"title":"</script>');
    // The viewer's own fallback check keeps the placeholder literal in its code.
    expect(page).toContain(PLACEHOLDER_REVIEW);
  });
});
