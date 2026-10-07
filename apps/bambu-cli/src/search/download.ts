import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { unzipWithin } from "../zip.ts";
import { UsageError } from "../cli.ts";
import { SOURCE_FILE, type Source } from "../job.ts";
import { sniffProblem, stallGuard, streamBody, type SniffFormat } from "../download.ts";
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
export function printablesId(input: string): string {
  if (modelId(input)) return input;
  try {
    const url = new URL(input);
    if (["makerworld.com", "www.makerworld.com"].includes(url.hostname))
      throw new UsageError(
        "MakerWorld pages need a login; pass the signed download link from the page's Download button instead.",
      );
    if (isSiteUrl("printables", input)) {
      const id = url.pathname.match(/^\/model\/(\d+)(?:-|\/|$)/)?.[1];
      if (id) return id;
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
  }
  throw new UsageError("Expected a Printables model URL or numeric id.");
}
export const MODEL_QUERY = `query DownloadModel($id: ID!) { print(id: $id) { id name slug user { publicUsername } license { abbreviation } stls { id name fileSize } } }`;
export const LINK_MUTATION = `mutation DownloadFile($id: ID!, $modelId: ID!) { getDownloadLink(id: $id, printId: $modelId, fileType: stl, source: model_detail) { ok errors { field messages } output { link ttl } } }`;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const STALL_MS = 30_000;
const MODEL_EXTENSIONS = new Set([".stl", ".3mf", ".obj", ".glb", ".ply"]);
const COMPANION_EXTENSIONS = new Set([".mtl", ".png", ".jpg", ".jpeg"]);
// A MakerWorld download link: the page's Download button hands the browser a
// short-lived signed URL on Bambu's CDN, which needs no login to fetch.
export function makerworldLink(input: string): URL | undefined {
  try {
    const url = new URL(input);
    if (
      url.protocol === "https:" &&
      (url.hostname === "bblmw.com" || url.hostname.endsWith(".bblmw.com")) &&
      !url.username &&
      !url.password
    )
      return url;
  } catch {
    // Not a URL at all.
  }
  return undefined;
}
// A file name as the site or archive gave it, kept verbatim (an MTL refers to
// its texture by exact name) once it is known to be a plain name.
function safeName(name: unknown, site: string): string {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    basename(name) !== name ||
    name.includes("\\") ||
    /[\p{Cc}]/u.test(name)
  )
    throw new SiteError(`${site} returned an unsafe filename`);
  return name;
}
// An archive member's path relative to the job folder: every segment a plain
// name, so it cannot leave the folder. Subfolders are kept because an OBJ's
// MTL and texture references name them.
function safePath(member: string, site: string): string {
  for (const segment of member.split("/")) safeName(segment, site);
  return member;
}
// The one folder a "download all" zip wraps its files in, if every member shares it.
function commonFolder(members: string[]): string {
  const first = members[0]?.split("/");
  if (!first || first.length < 2) return "";
  const folder = `${first[0]}/`;
  return members.every((m) => m.startsWith(folder) && m.length > folder.length) ? folder : "";
}
type Files = Pick<
  typeof import("node:fs/promises"),
  "mkdir" | "writeFile" | "rm" | "open" | "rename" | "readFile"
>;
interface Staged {
  name: string;
  path: string;
  tmp: string;
  bytes: number;
}
// Download anonymous Printables Model files, or one MakerWorld download link,
// into a Print Job folder.
export async function fetchModel(
  input: string,
  {
    out = process.cwd(),
    force = false,
    page,
    fetcher = globalThis.fetch,
    fs = { mkdir, writeFile, rm, open, rename, readFile },
  }: {
    out?: string;
    force?: boolean;
    // The MakerWorld model page a download link came from, for the credit.
    page?: string;
    fetcher?: Fetch;
    fs?: Files;
  } = {},
) {
  const link = makerworldLink(input);
  return link
    ? fetchMakerworld(link, { out, force, page, fetcher, fs })
    : fetchPrintables(input, { out, force, fetcher, fs });
}
// Stream one file to `tmp`, abandoning it after 30 s without a byte however
// long the whole Model takes, and refusing anything past what a printable
// Model could be: by the declared size first, then by the bytes received. The
// head is kept so the caller can check the file is what it is named.
async function download(
  link: string,
  {
    tmp,
    name,
    expected,
    fetcher,
    fs,
  }: { tmp: string; name: string; expected: number; fetcher: Fetch; fs: Files },
): Promise<{ bytes: number; head: Buffer }> {
  const handle = await fs.open(tmp, "w");
  const stall = stallGuard(STALL_MS);
  try {
    const response = await fetcher(link, {
      headers: { "User-Agent": USER_AGENT },
      signal: stall.signal,
    });
    if (!response.ok) throw new SiteError(`HTTP ${response.status}`);
    const declared = Math.max(expected, Number(response.headers.get("content-length")) || 0);
    const over = () =>
      new SiteError(`${name} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
    if (declared > MAX_FILE_BYTES) throw over();
    return await streamBody(response, {
      stall,
      maxBytes: MAX_FILE_BYTES,
      over,
      write: async (chunk) => {
        await handle.write(chunk);
      },
    });
  } finally {
    stall.clear();
    await handle.close();
  }
}
// Each file streams to a .tmp beside its destination; the job is committed
// (renames and source.json) only once every download is complete, so a
// failure leaves nothing behind and --force never destroys the old job.
async function commit(
  out: string,
  names: string[],
  force: boolean,
  source: Source,
  fs: Files,
  stage: (staged: Staged[]) => Promise<void>,
) {
  await fs.mkdir(resolve(out), { recursive: true });
  if (!force)
    for (const name of [SOURCE_FILE, ...names])
      if (existsSync(resolve(out, name)))
        throw new Error(`EEXIST: ${resolve(out, name)} exists; pass --force to replace it`);
  const staged: Staged[] = [];
  try {
    await stage(staged);
    for (const { path, tmp } of staged) await fs.rename(tmp, path);
    await fs.writeFile(resolve(out, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  } catch (error) {
    await Promise.all(staged.map(({ tmp }) => fs.rm(tmp, { force: true })));
    throw error;
  }
  return staged.map(({ name, path, bytes }) => ({ name, path, bytes }));
}
// A single Model file, or a zip of them (MakerWorld's "download all"), from a
// signed link. Title and files come from the names; the page URL is optional credit.
async function fetchMakerworld(
  link: URL,
  {
    out,
    force,
    page,
    fetcher,
    fs,
  }: { out: string; force: boolean; page?: string; fetcher: Fetch; fs: Files },
) {
  const name = safeName(decodeURIComponent(basename(link.pathname)), "MakerWorld"),
    ext = extname(name).toLowerCase();
  if (ext !== ".zip" && !MODEL_EXTENSIONS.has(ext))
    throw new UsageError(
      `${name} is not a Model file or zip; expected STL, 3MF, OBJ, GLB, PLY, or a zip of them`,
    );
  if (page !== undefined && !isSiteUrl("makerworld", page))
    throw new UsageError("--page must be a makerworld.com model URL");
  const source: Source = {
    route: "Search",
    site: "MakerWorld",
    title: basename(name, extname(name)),
    url: page,
  };
  const skipped: string[] = [];
  const tmp = resolve(out, `${name}.tmp`);
  await fs.mkdir(resolve(out), { recursive: true });
  let archive: Record<string, Uint8Array> | undefined;
  const members = new Map<string, Uint8Array>();
  if (ext === ".zip") {
    // The archive is read once, up front, so the names it holds can be
    // checked against the folder before anything is staged.
    try {
      await download(link.href, { tmp, name, expected: 0, fetcher, fs });
      archive = unzipWithin(new Uint8Array(await fs.readFile(tmp)), {
        keep: (entry) => {
          if (entry.endsWith("/")) return false;
          const inner = extname(entry).toLowerCase();
          if (MODEL_EXTENSIONS.has(inner) || COMPANION_EXTENSIONS.has(inner)) return true;
          skipped.push(entry);
          return false;
        },
        limit: MAX_FILE_BYTES,
        over: () =>
          new SiteError(`${name} expands past the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`),
      });
    } finally {
      await fs.rm(tmp, { force: true });
    }
    const textured = Object.keys(archive).some((n) => extname(n).toLowerCase() === ".obj"),
      wrapper = commonFolder(Object.keys(archive));
    // Names are compared case-folded: the job folder is on a case-insensitive
    // filesystem by default, where Model.stl and model.stl are one file.
    const folded = new Set<string>();
    for (const [inner, data] of Object.entries(archive)) {
      const relative = safePath(inner.slice(wrapper.length), "MakerWorld"),
        innerExt = extname(relative).toLowerCase();
      if (!MODEL_EXTENSIONS.has(innerExt) && !textured) {
        skipped.push(inner);
        continue;
      }
      if (folded.has(relative.toLowerCase()))
        throw new SiteError(`${name} holds ${relative} twice`);
      folded.add(relative.toLowerCase());
      members.set(relative, data);
    }
    if (![...members.keys()].some((n) => MODEL_EXTENSIONS.has(extname(n).toLowerCase())))
      throw new SiteError(
        `no STL, 3MF, OBJ, GLB, or PLY file in ${name}${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`,
      );
  }
  const files = await commit(
    out,
    archive ? [...members.keys()] : [name],
    force,
    source,
    fs,
    async (staged) => {
      if (archive) {
        for (const [member, data] of members) {
          const path = resolve(out, member),
            memberTmp = `${path}.tmp`;
          staged.push({ name: member, path, tmp: memberTmp, bytes: data.length });
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(memberTmp, data);
          const format = extname(member).slice(1).toLowerCase();
          const problem = MODEL_EXTENSIONS.has(`.${format}`)
            ? sniffProblem(Buffer.from(data.subarray(0, 1024)), format as SniffFormat, data.length)
            : undefined;
          if (problem) throw new SiteError(`${member}: ${problem}`);
        }
        return;
      }
      const path = resolve(out, name);
      staged.push({ name, path, tmp, bytes: 0 });
      const { bytes, head } = await download(link.href, { tmp, name, expected: 0, fetcher, fs });
      // A signed host can answer 200 with an error page (or an expired-link
      // notice); the file must look like the Model it is named as.
      const problem = sniffProblem(head, ext.slice(1) as SniffFormat, bytes);
      if (problem) throw new SiteError(`${name}: ${problem}`);
      staged[0]!.bytes = bytes;
    },
  );
  return { model: { id: name, name: source.title, url: source.url }, source, files, skipped };
}
async function fetchPrintables(
  input: string,
  { out, force, fetcher, fs }: { out: string; force: boolean; fetcher: Fetch; fs: Files },
) {
  const id = printablesId(input);
  const model = mapping(
    graphqlData(
      await requestJson(PRINTABLES_ENDPOINT, { query: MODEL_QUERY, variables: { id } }, fetcher),
    ).print,
  );
  if (!modelId(model.id)) throw new SiteError("Printables model was not found");
  const skipped: string[] = [];
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
    const name = typeof file.name === "string" ? file.name : "",
      ext = extname(name).toLowerCase();
    // STEP and the like are skipped: neither analyze nor Bambu Studio's CLI
    // reads them. An OBJ's material library and textures come along for paint.
    const isModel = MODEL_EXTENSIONS.has(ext);
    if (!isModel && !(textured && COMPANION_EXTENSIONS.has(ext))) {
      skipped.push(name);
      continue;
    }
    safeName(file.name, "Printables");
    const fileId = modelId(file.id);
    if (!fileId) throw new SiteError("Printables returned an invalid file id");
    // Case-folded, as the job folder's filesystem is by default.
    if (names.has(name.toLowerCase())) throw new SiteError(`Printables lists ${name} twice`);
    names.add(name.toLowerCase());
    wanted.push({ name, fileId, fileSize: file.fileSize, model: isModel });
  }
  if (!wanted.some((f) => f.model))
    throw new SiteError(
      `no STL, 3MF, OBJ, GLB, or PLY file to download${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`,
    );
  const files = await commit(
    out,
    wanted.map((f) => f.name),
    force,
    source,
    fs,
    async (staged) => {
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
        const path = resolve(out, name),
          tmp = `${path}.tmp`;
        staged.push({ name, path, tmp, bytes: 0 });
        const expected = Number(fileSize) || 0;
        const { bytes, head } = await download(link, { tmp, name, expected, fetcher, fs });
        // Printables reports each file's exact size, so a body that ended early
        // (chunked, no Content-Length) is caught here rather than saved truncated.
        if (expected && bytes !== expected)
          throw new SiteError(`${name}: received ${bytes} of ${expected} bytes`);
        // A signed host can answer 200 with an error page; the file must look
        // like the Model it is named as before the job is committed.
        const problem = isModel
          ? sniffProblem(head, extname(name).slice(1).toLowerCase() as SniffFormat, bytes)
          : undefined;
        if (problem) throw new SiteError(`${name}: ${problem}`);
        staged[staged.length - 1]!.bytes = bytes;
      }
    },
  );
  return { model: { id, name: source.title, url: source.url }, source, files, skipped };
}
