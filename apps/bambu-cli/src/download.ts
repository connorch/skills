// What every Model download shares, whichever Route fetches it: a stall
// deadline instead of a whole-request one (large Models take minutes on a
// home connection), a byte cap on what is received, and a sniff of the first
// kilobyte so a signed host answering 200 with an error page is caught before
// the file is kept. The caller owns the file and the policy (cap, retries,
// exact-size checks); this only moves the bytes.

export type SniffFormat = "glb" | "3mf" | "stl" | "obj" | "ply";

// Only the first kilobyte and the file length are needed to tell a Model from an error page.
export const SNIFF_BYTES = 1024;
export function sniffProblem(
  head: Buffer,
  format: SniffFormat,
  length = head.length,
): string | undefined {
  if (!length) return "the download is empty";
  const text = head.toString().trimStart();
  if (/^[<{]/.test(text)) return `expected ${format.toUpperCase()} but got an HTML/JSON document`;
  const valid =
    format === "glb"
      ? head.toString("ascii", 0, 4) === "glTF"
      : format === "3mf"
        ? head.toString("ascii", 0, 2) === "PK"
        : format === "ply"
          ? /^ply\r?\n/.test(text)
          : format === "stl"
            ? (length >= 84 && head.length >= 84 && length === 84 + 50 * head.readUInt32LE(80)) ||
              /^solid/i.test(text)
            : /^(v|vn|vt|f|o|g|mtllib|usemtl|s)\s/.test(
                text
                  .split("\n")
                  .map((l) => l.trim())
                  .find((l) => l && !l.startsWith("#")) || "",
              );
  return valid ? undefined : `the download is not a ${format.toUpperCase()} file`;
}

// An abort signal that fires after `ms` without `touch()`; pass `signal` to
// the fetch and touch it on every chunk.
export function stallGuard(ms: number) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

// Copy a response body through `write`, refusing it past `maxBytes` with the
// caller's error. Returns the byte count and the head kept for sniffing.
export async function streamBody(
  response: Response,
  {
    stall,
    maxBytes,
    over,
    write,
  }: {
    stall: ReturnType<typeof stallGuard>;
    maxBytes: number;
    over: () => Error;
    write: (chunk: Uint8Array) => void | Promise<void>;
  },
): Promise<{ bytes: number; head: Buffer }> {
  let bytes = 0,
    head = Buffer.alloc(0);
  for await (const chunk of response.body ?? []) {
    stall.touch();
    bytes += chunk.length;
    if (bytes > maxBytes) {
      await response.body?.cancel();
      throw over();
    }
    if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
    await write(chunk);
  }
  return { bytes, head };
}
