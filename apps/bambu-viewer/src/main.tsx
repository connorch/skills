// Entry: read the Review and the GLB that `bambu view` embedded in the page,
// or the sample in public/ while developing, then mount the App.

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadModel } from "./model.ts";
import { PLACEHOLDER_MODEL, PLACEHOLDER_REVIEW, type Review } from "./review.ts";
import "./styles.css";

async function embedded(): Promise<{ review: Review; glb: string }> {
  const reviewText = document.getElementById("review")?.textContent?.trim() ?? "";
  const glb = document.getElementById("model")?.textContent?.trim() ?? "";
  if (reviewText && reviewText !== PLACEHOLDER_REVIEW && glb !== PLACEHOLDER_MODEL) {
    return { review: JSON.parse(reviewText) as Review, glb };
  }
  // Unfilled template: the dev server serves a sample from public/.
  const [review, bytes] = await Promise.all([
    fetch("/sample/review.json").then((r) => r.json() as Promise<Review>),
    fetch("/sample/model.glb").then((r) => r.arrayBuffer()),
  ]);
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return { review, glb: btoa(binary) };
}

const root = createRoot(document.getElementById("root")!);
try {
  const { review, glb } = await embedded();
  document.title = `${review.job} · Review Page`;
  const model = await loadModel(glb);
  root.render(<App review={review} model={model} />);
} catch (error) {
  root.render(<p className="error">Could not load the model: {String(error)}</p>);
}
