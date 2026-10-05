// Where a Model came from, kept as `source.json` in its Print Job folder so
// the Review Page can credit it without the agent re-typing anything.
// Written by the Route that produced the Model (fetch today); read by view.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const Source = z.object({
  route: z.enum(["Search", "Generate", "Make", "Own File"]),
  title: z.string().optional(),
  site: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  license: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const SOURCE_FILE = "source.json";

export function writeSource(folder: string, source: Source): string {
  const file = join(folder, SOURCE_FILE);
  writeFileSync(file, `${JSON.stringify(source, null, 2)}\n`);
  return file;
}

// The source recorded beside a Model, if its folder has one.
export function readSource(modelPath: string): Source | undefined {
  try {
    return Source.parse(JSON.parse(readFileSync(join(dirname(modelPath), SOURCE_FILE), "utf8")));
  } catch {
    return undefined;
  }
}
