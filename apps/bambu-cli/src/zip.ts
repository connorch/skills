import { unzipSync } from "fflate";
// Inflate only the members `keep` wants, and refuse the archive with `over`
// once they would expand past `limit` bytes, so a hostile or huge zip cannot
// exhaust memory before its contents are inspected.
export function unzipWithin(
  bytes: Uint8Array,
  { keep, limit, over }: { keep: (name: string) => boolean; limit: number; over: () => Error },
): Record<string, Uint8Array> {
  let expanded = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      if (!keep(entry.name)) return false;
      expanded += entry.originalSize ?? entry.size;
      if (expanded > limit) throw over();
      return true;
    },
  });
}
