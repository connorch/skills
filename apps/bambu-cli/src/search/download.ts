import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { SOURCE_FILE, type Source } from "../job.ts";
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
// Download anonymous Printables Model files into a Print Job folder.
export async function fetchModel(
  input: string,
  {
    out = process.cwd(),
    force = false,
    fetcher = globalThis.fetch,
    fs = { mkdir, writeFile },
  }: {
    out?: string;
    force?: boolean;
    fetcher?: Fetch;
    fs?: Pick<typeof import("node:fs/promises"), "mkdir" | "writeFile">;
  } = {},
) {
  const id = printablesId(input);
  const model = mapping(
    graphqlData(
      await requestJson(PRINTABLES_ENDPOINT, { query: MODEL_QUERY, variables: { id } }, fetcher),
    ).print,
  );
  if (!modelId(model.id)) throw new SiteError("Printables model was not found");
  const files: { name: string; path: string; bytes: number }[] = [],
    skipped: string[] = [];
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
  const wanted: { name: string; fileId: string; fileSize: unknown }[] = [];
  for (const file of mappings(model.stls)) {
    const name = text(file.name);
    // STEP is skipped: neither analyze nor Bambu Studio's CLI reads it.
    if (![".stl", ".3mf", ".obj"].includes(extname(name).toLowerCase())) {
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
    wanted.push({ name, fileId, fileSize: file.fileSize });
  }
  if (!force)
    for (const name of [SOURCE_FILE, ...wanted.map((f) => f.name)])
      if (existsSync(resolve(out, name)))
        throw new Error(`EEXIST: ${resolve(out, name)} exists; pass --force to replace it`);
  await fs.writeFile(resolve(out, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  for (const { name, fileId, fileSize } of wanted) {
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
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), STALL_MS);
    const response = await fetcher(link, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new SiteError(`HTTP ${response.status}`);
    // The file is read into memory, so refuse anything past what a printable
    // Model could be: by the declared size first, then by the bytes received.
    const declared = Math.max(
      Number(fileSize) || 0,
      Number(response.headers.get("content-length")) || 0,
    );
    const over = () =>
      new SiteError(`${name} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
    if (declared > MAX_FILE_BYTES) throw over();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for await (const chunk of response.body ?? []) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), STALL_MS);
        received += chunk.length;
        if (received > MAX_FILE_BYTES) {
          await response.body?.cancel();
          throw over();
        }
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(timer);
    }
    const bytes = Buffer.concat(chunks),
      path = resolve(out, name);
    await fs.writeFile(path, bytes);
    files.push({ name, path, bytes: bytes.length });
  }
  return { model: { id, name: source.title, url: source.url }, source, files, skipped };
}
