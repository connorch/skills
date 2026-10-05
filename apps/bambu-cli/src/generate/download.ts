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
export function sniffProblem(data: Buffer, format: OutputFormat): string | undefined {
  if (!data.length) return "the download is empty";
  const head = data.subarray(0, 1024);
  const text = head.toString().trimStart();
  if (/^[<{]/.test(text)) return `expected ${format.toUpperCase()} but got an HTML/JSON document`;
  const valid =
    format === "glb"
      ? head.toString("ascii", 0, 4) === "glTF"
      : format === "3mf"
        ? head.toString("ascii", 0, 2) === "PK"
        : format === "stl"
          ? (data.length >= 84 && data.length === 84 + 50 * data.readUInt32LE(80)) ||
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
      const response = await http.send(url);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > 1024 ** 3)
        throw new ProviderError("too_large", "model exceeds 1073741824 bytes");
      const handle = io.openSync(tmp, "w");
      let written = 0;
      try {
        if (response.body)
          for await (const chunk of response.body) {
            written += chunk.byteLength;
            if (written > 1024 ** 3)
              throw new ProviderError("too_large", "model exceeds 1073741824 bytes");
            io.writeSync(handle, chunk);
          }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("network", "download interrupted", true);
      } finally {
        io.closeSync(handle);
      }
      if (declared && !response.headers.get("content-encoding") && declared !== written)
        throw new ProviderError(
          "truncated",
          `download stopped at ${written} of ${declared} bytes`,
          true,
        );
      const problem = sniffProblem(io.readFileSync(tmp), chosen);
      if (problem) throw new ProviderError("not_a_model", problem);
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
