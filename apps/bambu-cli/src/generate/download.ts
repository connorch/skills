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
  format: OutputFormat,
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
      const problem = sniffProblem(readHead(tmp, io), chosen, written);
      if (problem) throw new ProviderError("not_a_model", problem);
      if (chosen === "glb") io.writeFileSync(tmp, standUpright(io.readFileSync(tmp)));
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
  const data = fs.readFileSync(path);
  if (data.length < 20 || data.readUInt32LE(16) !== 0x4e4f534a) return false;
  try {
    const document: unknown = JSON.parse(data.toString("utf8", 20, 20 + data.readUInt32LE(12)));
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
export function standUpright(glb: Buffer): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const doc = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength)) as {
    nodes?: { name?: string; children?: number[]; rotation?: number[] }[];
    scenes?: { nodes?: number[] }[];
  };
  const nodes = (doc.nodes ??= []);
  if (nodes.some((n) => n.name === UPRIGHT_NODE)) return glb;
  for (const scene of doc.scenes ?? []) {
    nodes.push({
      name: UPRIGHT_NODE,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      children: scene.nodes ?? [],
    });
    scene.nodes = [nodes.length - 1];
  }
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const rest = glb.subarray(20 + jsonLength);
  const out = Buffer.concat([glb.subarray(0, 12), Buffer.alloc(8), padded, rest]);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  return out;
}
