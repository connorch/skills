import { readFileSync } from "node:fs";
import { inline } from "../inline.ts";
import { TEMPLATE_FILE } from "./template.ts";

// Inline the built viewer so the installed CLI renders Review Pages on its own.
export function bundleViewerTemplate() {
  return inline(
    "/view/template.ts",
    () =>
      `export function template() { return ${JSON.stringify(readFileSync(TEMPLATE_FILE, "utf8"))}; }`,
  );
}
