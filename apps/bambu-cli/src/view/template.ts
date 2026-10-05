import { readFileSync } from "node:fs";

// The built viewer app (apps/bambu-viewer/dist/index.html). The pack plugin in
// bundle.ts inlines it; source runs read it from the workspace.
export const TEMPLATE_FILE = new URL("../../../bambu-viewer/dist/index.html", import.meta.url);

export function template(): string {
  return readFileSync(TEMPLATE_FILE, "utf8");
}
