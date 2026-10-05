// The data a Review Page shows. `bambu view` writes one of these into the
// built template's `#review` script; the page reads it back. The CLI imports
// this type, so the two sides cannot drift.

export type CheckStatus = "ok" | "warn" | "bad";

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  // Short value shown beside the label, e.g. "Watertight" or "7.4% past 45°".
  value: string;
  // One sentence of detail; shown for warnings and in the full list's tooltip.
  detail: string;
}

export interface Review {
  // Print Job name; also the page title.
  job: string;
  title: string;
  model: {
    file: string;
    triangles: number;
    // Bounding box in mm, as printed: X across, Y deep, Z up.
    size: [number, number, number];
  };
  source?: {
    route: "Search" | "Generate" | "Make" | "Own File";
    site?: string;
    author?: string;
    url?: string;
    license?: string;
  };
  printer: {
    name: string;
    // Build plate in mm, X Y Z.
    plate: [number, number, number];
  };
  report?: {
    score: number;
    checks: Check[];
  };
  print?: {
    estimate?: { minutes: number; grams: number };
    filament?: { name: string; color: string; hex: string; slot: string };
    // Suggested or chosen settings, in display order.
    settings: [label: string, value: string][];
  };
  // Present for a painted Model: every colour, its filament and Slot.
  palette?: { hex: string; name: string; slot: string; areaPct: number }[];
}

export const PLACEHOLDER_REVIEW = "__BAMBU_REVIEW_JSON__";
export const PLACEHOLDER_MODEL = "__BAMBU_MODEL_GLB_BASE64__";
