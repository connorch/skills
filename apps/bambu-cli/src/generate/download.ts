import * as fs from "node:fs";
import { join } from "node:path";
import { formats, HttpClient, ProviderError, type OutputFormat, type Status } from "./core.ts";

export function safeFilename(stem: string, suffix: string): string {
  return `${
    stem
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "model"
  }.${suffix}`;
}
// Only the first kilobyte and the file length are needed to tell a Model from an error page.
export const SNIFF_BYTES = 1024;
export function sniffProblem(
  head: Buffer,
  format: OutputFormat | "ply",
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

// Signed download URLs are refreshed from the task, with no credentials sent to file hosts.
const DOWNLOAD_STALL_MS = 120_000;
// A 3MF is a ZIP: its end-of-central-directory record sits in the last 64 KB.
function zipProblem(path: string, format: OutputFormat, io: typeof fs): string | undefined {
  if (format !== "3mf") return undefined;
  const size = io.statSync(path).size,
    tail = Buffer.alloc(Math.min(65_557, size)),
    handle = io.openSync(path, "r");
  try {
    io.readSync(handle, tail, 0, tail.length, size - tail.length);
  } finally {
    io.closeSync(handle);
  }
  return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ? undefined : "the 3MF is truncated";
}
// A chunked body can end cleanly mid-file; an ASCII STL must at least close.
function asciiStlProblem(path: string, format: OutputFormat, io: typeof fs): string | undefined {
  if (format !== "stl") return undefined;
  const head = readHead(path, io);
  if (!/^\s*solid/i.test(head.toString("latin1"))) return undefined;
  const size = io.statSync(path).size,
    tail = Buffer.alloc(Math.min(SNIFF_BYTES, size)),
    handle = io.openSync(path, "r");
  try {
    io.readSync(handle, tail, 0, tail.length, size - tail.length);
  } finally {
    io.closeSync(handle);
  }
  return /endsolid/i.test(tail.toString("latin1")) ? undefined : "the ASCII STL is truncated";
}
function readHead(path: string, io: typeof fs): Buffer {
  const handle = io.openSync(path, "r"),
    head = Buffer.alloc(SNIFF_BYTES);
  try {
    return head.subarray(0, io.readSync(handle, head, 0, SNIFF_BYTES, 0));
  } finally {
    io.closeSync(handle);
  }
}
export async function fetchListedOutput(
  http: HttpClient,
  poll: () => Promise<Status>,
  wanted: OutputFormat,
  dir: string,
  stem: string,
  io = fs,
): Promise<{ path: string; output_format: OutputFormat }> {
  let listing = await poll();
  if (listing.state !== "succeeded")
    throw new ProviderError("not_ready", `the task is ${listing.state}, not finished`);
  const chosen = [wanted, "glb" as const, ...formats].find((f) => listing.outputs[f]);
  if (!chosen)
    throw new ProviderError("no_output", "the finished task lists no downloadable model");
  const path = join(dir, safeFilename(stem, chosen));
  const tmp = `${path}.tmp`;
  io.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const url = listing.outputs[chosen];
      if (!url)
        throw new ProviderError(
          "no_output",
          `the task no longer lists a ${chosen.toUpperCase()} file`,
        );
      // Upstream's download read timeout: abandon a transfer that goes
      // 120 s without a byte, however long a large Model takes overall.
      const controller = new AbortController();
      let stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
      let response: Response;
      try {
        response = await http.send(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(stall);
        throw error;
      }
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > 1024 ** 3) {
        clearTimeout(stall);
        throw new ProviderError("too_large", "model exceeds 1073741824 bytes");
      }
      const handle = io.openSync(tmp, "w");
      let written = 0;
      try {
        if (response.body)
          for await (const chunk of response.body) {
            clearTimeout(stall);
            stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
            written += chunk.byteLength;
            if (written > 1024 ** 3)
              throw new ProviderError("too_large", "model exceeds 1073741824 bytes");
            io.writeSync(handle, chunk);
          }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("network", "download interrupted", true);
      } finally {
        clearTimeout(stall);
        io.closeSync(handle);
      }
      if (declared && !response.headers.get("content-encoding") && declared !== written)
        throw new ProviderError(
          "truncated",
          `download stopped at ${written} of ${declared} bytes`,
          true,
        );
      const problem =
        sniffProblem(readHead(tmp, io), chosen, written) ??
        asciiStlProblem(tmp, chosen, io) ??
        zipProblem(tmp, chosen, io);
      if (problem) throw new ProviderError("not_a_model", problem);
      if (chosen === "glb") {
        // Validates the header and chunk boundaries as well.
        const handle = io.openSync(tmp, "r");
        try {
          readJsonChunk(handle, io);
        } finally {
          io.closeSync(handle);
        }
        standUprightFile(tmp, io);
      }
      io.renameSync(tmp, path);
      return { path, output_format: chosen };
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        attempt >= 2 ||
        !(error.retryable || [403, 404, 410].includes(error.http_status ?? 0))
      )
        throw error;
      listing = await poll();
    } finally {
      io.rmSync(tmp, { force: true });
    }
  }
}

export function hasTexture(path: string, format: OutputFormat): boolean {
  if (format !== "glb") return false;
  // Only the header and JSON chunk are read; the binary chunk stays on disk.
  const handle = fs.openSync(path, "r");
  let json: Buffer;
  try {
    json = readJsonChunk(handle, fs).json;
  } catch {
    return false;
  } finally {
    fs.closeSync(handle);
  }
  try {
    const document: unknown = JSON.parse(json.toString("utf8"));
    if (
      typeof document !== "object" ||
      document === null ||
      !("materials" in document) ||
      !Array.isArray(document.materials)
    )
      return false;
    return document.materials.some((material: unknown) => {
      if (
        typeof material !== "object" ||
        material === null ||
        !("pbrMetallicRoughness" in material)
      )
        return false;
      const pbr = material.pbrMetallicRoughness;
      return typeof pbr === "object" && pbr !== null && "baseColorTexture" in pbr;
    });
  } catch {
    return false;
  }
}

// glTF is Y-up and the printer is Z-up. Wrap every scene's roots in one
// rotated node, as upstream does, so the Model stands as the provider meant
// it; Bambu Studio and the mesh loader bake node transforms into vertices.
// Only the JSON chunk changes, so meshes and textures are byte-identical.
// Idempotent: a GLB that already has the node is returned unchanged.
export const UPRIGHT_NODE = "bambu-upright";
// Upstream's Python port named the same node differently; files it generated are Z-up too.
export const UPRIGHT_NODES = new Set([UPRIGHT_NODE, "bambu-studio-ai: Y-up to Z-up"]);
// The new JSON chunk (padded, with its 8-byte chunk header) for a GLB whose
// JSON chunk is `json`, or undefined when the file is already upright.
export function uprightChunk(json: string): Buffer | undefined {
  const doc = JSON.parse(json) as {
    nodes?: { name?: string; children?: number[]; rotation?: number[] }[];
    scenes?: { nodes?: number[] }[];
  };
  const nodes = (doc.nodes ??= []);
  if (nodes.some((n) => n.name !== undefined && UPRIGHT_NODES.has(n.name))) return undefined;
  for (const scene of doc.scenes ?? []) {
    nodes.push({
      name: UPRIGHT_NODE,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      children: scene.nodes ?? [],
    });
    scene.nodes = [nodes.length - 1];
  }
  const text = Buffer.from(JSON.stringify(doc));
  const chunk = Buffer.alloc(8 + Math.ceil(text.length / 4) * 4, 0x20);
  chunk.writeUInt32LE(chunk.length - 8, 0);
  chunk.writeUInt32LE(0x4e4f534a, 4);
  text.copy(chunk, 8);
  return chunk;
}
export function standUpright(glb: Buffer): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const chunk = uprightChunk(glb.toString("utf8", 20, 20 + jsonLength));
  if (!chunk) return glb;
  const out = Buffer.concat([glb.subarray(0, 12), chunk, glb.subarray(20 + jsonLength)]);
  out.writeUInt32LE(out.length, 8);
  return out;
}
// The same rewrite on disk: only the JSON chunk is held in memory, the binary
// chunk is copied through in pieces, so a large download is never loaded whole.
// Header and JSON chunk of an open GLB, checked against the file before the
// chunk is allocated: a bad header or a chunk the file cannot hold is refused.
const MAX_JSON_CHUNK = 64 * 1024 * 1024;
function readJsonChunk(
  handle: number,
  io: typeof fs,
): { header: Buffer; json: Buffer; total: number } {
  const header = Buffer.alloc(20),
    total = io.fstatSync(handle).size;
  if (io.readSync(handle, header, 0, 20, 0) < 20 || header.toString("ascii", 0, 4) !== "glTF")
    throw new ProviderError("not_a_model", "the download is not a GLB file");
  const jsonLength = header.readUInt32LE(12);
  if (
    header.readUInt32LE(16) !== 0x4e4f534a ||
    jsonLength > MAX_JSON_CHUNK ||
    20 + jsonLength > total ||
    header.readUInt32LE(8) !== total
  )
    throw new ProviderError("not_a_model", "the GLB header does not match the file");
  // Every chunk after the JSON one must fit; a body that ended mid-chunk does not.
  const chunk = Buffer.alloc(8);
  for (let at = 20 + jsonLength; at < total;) {
    if (io.readSync(handle, chunk, 0, 8, at) < 8 || at + 8 + chunk.readUInt32LE(0) > total)
      throw new ProviderError("not_a_model", "the GLB is truncated");
    at += 8 + chunk.readUInt32LE(0);
  }
  const json = Buffer.alloc(jsonLength);
  io.readSync(handle, json, 0, jsonLength, 20);
  return { header, json, total };
}
export function standUprightFile(path: string, io: typeof fs): void {
  const input = io.openSync(path, "r");
  let output: number | undefined;
  const out = `${path}.upright`;
  try {
    const { header, json, total } = readJsonChunk(input, io),
      jsonLength = json.length;
    const chunk = uprightChunk(json.toString("utf8"));
    if (!chunk) return;
    output = io.openSync(out, "w");
    const rest = total - 20 - jsonLength;
    header.writeUInt32LE(12 + chunk.length + rest, 8);
    io.writeSync(output, header, 0, 12);
    io.writeSync(output, chunk);
    const piece = Buffer.alloc(1 << 20);
    for (let position = 20 + jsonLength; position < total;) {
      const read = io.readSync(input, piece, 0, piece.length, position);
      if (!read) break;
      io.writeSync(output, piece, 0, read);
      position += read;
    }
  } finally {
    io.closeSync(input);
    if (output !== undefined) io.closeSync(output);
  }
  io.renameSync(out, path);
}
