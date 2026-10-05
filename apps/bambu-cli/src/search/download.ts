import { existsSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { SOURCE_FILE, type Source } from "../job.ts";
import { SNIFF_BYTES, sniffProblem } from "../generate/download.ts";
import type { OutputFormat } from "../generate/core.ts";
import {
  graphqlData,
  isSiteUrl,
  mapping,
  mappings,
  modelId,
  pageUrl,
  PRINTABLES_ENDPOINT,
  requestJson,
  SiteError,
  text,
  USER_AGENT,
  type Fetch,
} from "./core.ts";
export class FetchUsageError extends Error {}
export function printablesId(input: string): string {
  if (modelId(input)) return input;
  try {
    const url = new URL(input);
    if (["makerworld.com", "www.makerworld.com"].includes(url.hostname))
      throw new FetchUsageError(
        "MakerWorld needs a login. Download the file into the Print Job folder yourself.",
      );
    if (isSiteUrl("printables", input)) {
      const id = url.pathname.match(/^\/model\/(\d+)(?:-|\/|$)/)?.[1];
      if (id) return id;
    }
  } catch (error) {
    if (error instanceof FetchUsageError) throw error;
  }
  throw new FetchUsageError("Expected a Printables model URL or numeric id.");
}
export const MODEL_QUERY = `query DownloadModel($id: ID!) { print(id: $id) { id name slug user { publicUsername } license { abbreviation } stls { id name fileSize } } }`;
export const LINK_MUTATION = `mutation DownloadFile($id: ID!, $modelId: ID!) { getDownloadLink(id: $id, printId: $modelId, fileType: stl, source: model_detail) { ok errors { field messages } output { link ttl } } }`;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const STALL_MS = 30_000;
const MODEL_EXTENSIONS = new Set([".stl", ".3mf", ".obj", ".glb"]);
const COMPANION_EXTENSIONS = new Set([".mtl", ".png", ".jpg", ".jpeg"]);
// Download anonymous Printables Model files into a Print Job folder.
export async function fetchModel(
  input: string,
  {
    out = process.cwd(),
    force = false,
    fetcher = globalThis.fetch,
    fs = { mkdir, writeFile, rm, open, rename },
  }: {
    out?: string;
    force?: boolean;
    fetcher?: Fetch;
    fs?: Pick<typeof import("node:fs/promises"), "mkdir" | "writeFile" | "rm" | "open" | "rename">;
  } = {},
) {
  const id = printablesId(input);
  const model = mapping(
    graphqlData(
      await requestJson(PRINTABLES_ENDPOINT, { query: MODEL_QUERY, variables: { id } }, fetcher),
    ).print,
  );
  if (!modelId(model.id)) throw new SiteError("Printables model was not found");
  const skipped: string[] = [];
  await fs.mkdir(resolve(out), { recursive: true });
  const source: Source = {
    route: "Search",
    site: "Printables",
    title: text(model.name),
    author: text(mapping(model.user).publicUsername) || undefined,
    url: pageUrl("printables", id, model.slug),
    license: text(mapping(model.license).abbreviation) || undefined,
  };
  // Every destination, provenance included, is checked before anything is
  // written so a folder holding another Model is refused up front unless forced.
  const wanted: { name: string; fileId: string; fileSize: unknown; model: boolean }[] = [];
  const listed = mappings(model.stls),
    textured = listed.some((f) => extname(text(f.name)).toLowerCase() === ".obj");
  const names = new Set<string>();
  for (const file of listed) {
    // The name is kept verbatim (an MTL refers to its texture by exact name);
    // only its safety is checked.
    const name = typeof file.name === "string" ? file.name : "",
      ext = extname(name).toLowerCase();
    // STEP and the like are skipped: neither analyze nor Bambu Studio's CLI
    // reads them. An OBJ's material library and textures come along for paint.
    const isModel = MODEL_EXTENSIONS.has(ext);
    if (!isModel && !(textured && COMPANION_EXTENSIONS.has(ext))) {
      skipped.push(name);
      continue;
    }
    if (
      !name ||
      basename(name) !== name ||
      name.includes("\\") ||
      /[\p{Cc}]/u.test(String(file.name))
    )
      throw new SiteError("Printables returned an unsafe filename");
    const fileId = modelId(file.id);
    if (!fileId) throw new SiteError("Printables returned an invalid file id");
    if (names.has(name)) throw new SiteError(`Printables lists ${name} twice`);
    names.add(name);
    wanted.push({ name, fileId, fileSize: file.fileSize, model: isModel });
  }
  if (!wanted.some((f) => f.model))
    throw new SiteError(
      `no STL, 3MF, OBJ, or GLB file to download${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`,
    );
  if (!force)
    for (const name of [SOURCE_FILE, ...wanted.map((f) => f.name)])
      if (existsSync(resolve(out, name)))
        throw new Error(`EEXIST: ${resolve(out, name)} exists; pass --force to replace it`);
  // Each file streams to a .tmp beside its destination; the job is committed
  // (renames and source.json) only once every download is complete, so a
  // failure leaves nothing behind and --force never destroys the old job.
  const staged: { name: string; path: string; tmp: string; bytes: number }[] = [];
  try {
    await downloadAll();
    for (const { path, tmp } of staged) await fs.rename(tmp, path);
    await fs.writeFile(resolve(out, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  } catch (error) {
    await Promise.all(staged.map(({ tmp }) => fs.rm(tmp, { force: true })));
    throw error;
  }
  const files = staged.map(({ name, path, bytes }) => ({ name, path, bytes }));
  return { model: { id, name: source.title, url: source.url }, source, files, skipped };
  async function downloadAll() {
    for (const { name, fileId, fileSize, model: isModel } of wanted) {
      const result = mapping(
        graphqlData(
          await requestJson(
            PRINTABLES_ENDPOINT,
            { query: LINK_MUTATION, variables: { id: fileId, modelId: id } },
            fetcher,
          ),
        ).getDownloadLink,
      );
      if (result.ok !== true)
        throw new SiteError(
          `Printables could not create a download link: ${JSON.stringify(result.errors ?? [])}`,
        );
      const link = text(mapping(result.output).link);
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new SiteError("Printables returned an invalid download link");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new SiteError("Printables returned an unsafe download link");
      // Large Models take minutes on a home connection, so the deadline is on
      // inactivity: the request is abandoned after 30 s without a byte.
      const path = resolve(out, name),
        tmp = `${path}.tmp`;
      staged.push({ name, path, tmp, bytes: 0 });
      const handle = await fs.open(tmp, "w");
      const controller = new AbortController();
      let timer = setTimeout(() => controller.abort(), STALL_MS);
      let received = 0,
        head = Buffer.alloc(0);
      try {
        const response = await fetcher(link, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        if (!response.ok) throw new SiteError(`HTTP ${response.status}`);
        // Refuse anything past what a printable Model could be: by the
        // declared size first, then by the bytes received.
        const declared = Math.max(
          Number(fileSize) || 0,
          Number(response.headers.get("content-length")) || 0,
        );
        const over = () =>
          new SiteError(`${name} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
        if (declared > MAX_FILE_BYTES) throw over();
        for await (const chunk of response.body ?? []) {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), STALL_MS);
          received += chunk.length;
          if (received > MAX_FILE_BYTES) {
            await response.body?.cancel();
            throw over();
          }
          if (head.length < SNIFF_BYTES)
            head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
          await handle.write(chunk);
        }
      } finally {
        clearTimeout(timer);
        await handle.close();
      }
      // Printables reports each file's exact size, so a body that ended early
      // (chunked, no Content-Length) is caught here rather than saved truncated.
      const expected = Number(fileSize) || 0;
      if (expected && received !== expected)
        throw new SiteError(`${name}: received ${received} of ${expected} bytes`);
      // A signed host can answer 200 with an error page; the file must look
      // like the Model it is named as before the job is committed.
      const problem = isModel
        ? sniffProblem(head, extname(name).slice(1).toLowerCase() as OutputFormat, received)
        : undefined;
      if (problem) throw new SiteError(`${name}: ${problem}`);
      staged[staged.length - 1]!.bytes = received;
    }
  }
}
