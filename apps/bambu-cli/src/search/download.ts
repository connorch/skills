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
    const response = await fetcher(link, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SiteError(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()),
      path = resolve(out, name);
    await fs.writeFile(path, bytes, { flag: force ? "w" : "wx" });
    files.push({ name, path, bytes: bytes.length });
  }
  const source: Source = {
    route: "Search",
    site: "Printables",
    title: text(model.name),
    author: text(mapping(model.user).publicUsername) || undefined,
    url: pageUrl("printables", id, model.slug),
    license: text(mapping(model.license).abbreviation) || undefined,
  };
  if (files.length)
    await fs.writeFile(resolve(out, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  return { model: { id, name: source.title, url: source.url }, source, files, skipped };
}
