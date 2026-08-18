// wovn - CLI for the files.wovn.org file host (see skills/wovn-file-hosting).
//
// --private uploads to private.wovn.org (Cloudflare Access-gated; only Connor
// can read) using the Access service token in ~/.config/wovn-files/access.env.
//
// Token resolution: ~/.config/wovn-files/token.txt first (canonical on this
// machine, survives rotation without a new shell), FILE_HOST_TOKEN env second
// (for machines that only have the env var).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";

// WOVN_HOST / WOVN_PRIVATE_HOST are test hooks for pointing at wrangler dev.
const HOST = process.env.WOVN_HOST ?? "https://files.wovn.org";
const PRIVATE_HOST = process.env.WOVN_PRIVATE_HOST ?? "https://private.wovn.org";
const TOKEN_FILE = join(homedir(), ".config", "wovn-files", "token.txt");
const ACCESS_ENV_FILE = join(homedir(), ".config", "wovn-files", "access.env");
// Personal Cloudflare account (connorchev@gmail.com), where the wovn-files worker lives.
const ACCOUNT_ID = "290536f56594ac82bc4bacde9af0e082";

function fail(message: string): never {
  console.error(`wovn: ${message}`);
  process.exit(1);
}

function token(): string {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    const env = process.env.FILE_HOST_TOKEN;
    if (env) return env;
    fail(`no token at ${TOKEN_FILE} and FILE_HOST_TOKEN is unset`);
  }
}

// Access service token creds, parsed from the shell-sourceable access.env
// (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET lines).
function accessHeaders(reason: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(ACCESS_ENV_FILE, "utf8");
  } catch {
    fail(`${reason} needs ${ACCESS_ENV_FILE}`);
  }
  const value = (name: string) =>
    text.match(new RegExp(`^(?:export +)?${name}=["']?([^"'\\r\\n]+)`, "m"))?.[1];
  const id = value("CF_ACCESS_CLIENT_ID");
  const secret = value("CF_ACCESS_CLIENT_SECRET");
  if (!id || !secret) fail(`missing CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET in ${ACCESS_ENV_FILE}`);
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

// Git context inferred from the environment wovn runs in. Uploads are tagged
// with it (as x-wovn-* headers -> R2 customMetadata) and `wovn list` filters
// by it, so nothing has to be passed explicitly.
interface GitContext {
  dir: string; // cwd, always present
  branch?: string; // unset outside a repo or on a detached HEAD
  worktree?: string; // checkout root (--show-toplevel)
  project?: string; // basename of the main worktree - the project this checkout came from
  projectPath?: string; // full path of the main worktree
}

function git(...args: string[]): string | undefined {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function gitContext(): GitContext {
  const context: GitContext = { dir: process.cwd() };
  const worktree = git("rev-parse", "--show-toplevel");
  if (!worktree) return context;
  context.worktree = worktree;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch && branch !== "HEAD") context.branch = branch;
  // The first entry of `git worktree list` is always the main worktree, i.e.
  // the project a linked worktree was created off of (in the main checkout it
  // coincides with the worktree itself).
  const main = git("worktree", "list", "--porcelain")?.match(/^worktree (.+)$/m)?.[1];
  if (main) {
    context.projectPath = main;
    context.project = basename(main);
  }
  return context;
}

interface PutOptions {
  private?: true;
  name?: string;
  at?: string;
  force?: true;
}

async function put(files: string[], opts: PutOptions): Promise<void> {
  if (opts.name !== undefined && files.length > 1) fail("--name only applies to a single file");
  if (opts.at !== undefined && files.length > 1) fail("--at only applies to a single file");
  if (opts.at !== undefined && opts.name !== undefined) fail("--at already names the file; drop --name");
  if (opts.force && opts.at === undefined) fail("--force only applies to --at uploads");

  const host = opts.private ? PRIVATE_HOST : HOST;
  const headers: Record<string, string> = opts.private
    ? accessHeaders("--private")
    : { authorization: `Bearer ${token()}` };
  if (opts.force) headers["x-wovn-force"] = "1";

  // Tag the upload with where it came from. Header values must be ASCII, so
  // the rare non-ASCII path is skipped rather than breaking the upload.
  const context = gitContext();
  const meta: [string, string | undefined][] = [
    ["x-wovn-dir", context.dir],
    ["x-wovn-branch", context.branch],
    ["x-wovn-worktree", context.worktree],
    ["x-wovn-project", context.project],
    ["x-wovn-project-path", context.projectPath],
  ];
  for (const [header, value] of meta) {
    if (value && /^[\x20-\x7e]+$/.test(value)) headers[header] = value;
  }

  for (const file of files) {
    // A file-backed Blob streams the upload with a known Content-Length
    // (R2 rejects chunked bodies) without reading the file into memory.
    let blob: Blob;
    try {
      blob = await openAsBlob(file);
    } catch {
      fail(`cannot read ${file}`);
    }
    // POST mints an immutable dated key; PUT (--at) writes the exact path.
    const method = opts.at === undefined ? "POST" : "PUT";
    const path =
      opts.at ?? (opts.name ?? basename(file)).replace(/[^a-zA-Z0-9._-]/g, "-");
    const res = await fetch(`${host}/${path}`, { method, headers, body: blob });
    const body = await res.text();
    if (res.status === 409) fail(`${host}/${path} already exists; pass --force to replace it`);
    if (!res.ok) fail(`upload failed (${res.status}): ${body.trim()}`);
    process.stdout.write(body);
  }
}

interface ListEntry {
  key: string;
  size: number;
  uploaded: string;
}

function formatSize(bytes: number): string {
  let value = bytes;
  let unit = "B";
  for (const next of ["KB", "MB", "GB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

// ISO timestamp -> "yyyy-mm-dd hh:mm" in local time.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// File-type categories the `list` endpoint understands. Kept in sync with
// TYPE_CATEGORIES in worker/src/index.ts, which does the actual matching; the
// CLI only needs the names so it can reject typos before making a request.
const TYPE_CATEGORIES = ["image", "video", "document", "data", "archive"];

// --type values: categories and/or bare extensions, comma-separated and/or
// repeated. Collected into one list and sent as a single query param.
function collectTypes(value: string, previous: string[] = []): string[] {
  const values = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) fail("--type needs at least one category or extension");
  for (const entry of values) {
    if (TYPE_CATEGORIES.includes(entry)) continue;
    // Anything else is treated as a literal extension; reject values that
    // cannot be one rather than silently matching nothing.
    if (!/^[a-z0-9]+$/.test(entry)) {
      fail(`unknown --type ${entry}; use a category (${TYPE_CATEGORIES.join(", ")}) or a file extension`);
    }
  }
  return [...previous, ...values];
}

interface ListOptions {
  public?: true;
  private?: true;
  limit: string;
  // Filter flags take an optional value; `true` means "infer from the
  // current environment" (e.g. bare --branch = the branch I'm on now).
  project?: string | true;
  branch?: string | true;
  worktree?: string | true;
  dir?: string | true;
  type?: string[];
}

async function list(opts: ListOptions): Promise<void> {
  if (opts.public && opts.private) fail("--public and --private are mutually exclusive");
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");

  const query = new URLSearchParams({ list: "", limit: String(limit) });
  const context = gitContext();
  const inferred = {
    // The full path is the exact identity; the server matches --project
    // against both the project name and its path.
    project: context.projectPath,
    branch: context.branch,
    worktree: context.worktree,
    dir: context.dir,
  };
  for (const name of ["project", "branch", "worktree", "dir"] as const) {
    const value = opts[name];
    if (value === undefined) continue;
    const resolved = value === true ? inferred[name] : value;
    if (!resolved) fail(`--${name} has no value and none can be inferred from the current directory`);
    query.set(name, resolved);
  }
  if (opts.type) query.set("type", opts.type.join(","));

  const hosts: { host: string; headers: Record<string, string> }[] = [];
  if (!opts.private) hosts.push({ host: HOST, headers: { authorization: `Bearer ${token()}` } });
  if (!opts.public) hosts.push({ host: PRIVATE_HOST, headers: accessHeaders("listing private files") });

  const entries = (
    await Promise.all(
      hosts.map(async ({ host, headers }) => {
        const res = await fetch(`${host}/?${query}`, { headers });
        if (!res.ok) fail(`list failed for ${host} (${res.status}): ${(await res.text()).trim()}`);
        const objects = (await res.json()) as ListEntry[];
        return objects.map((entry) => ({ ...entry, url: `${host}/${entry.key}` }));
      }),
    )
  ).flat();

  // Merge both hosts newest-first; --limit caps the combined output.
  entries.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  for (const entry of entries.slice(0, limit)) {
    console.log(`${formatWhen(entry.uploaded)}  ${formatSize(entry.size).padStart(9)}  ${entry.url}`);
  }
}

// A target is a wovn URL on either host, or a bare path on the private host
// (public URLs need no CLI anyway). Private targets carry the Access headers;
// public reads need no auth.
function resolveTarget(
  target: string,
  reason: string,
): { host: string; key: string; headers: Record<string, string> } {
  if (target.startsWith(`${HOST}/`)) {
    return { host: HOST, key: target.slice(HOST.length + 1), headers: {} };
  }
  if (/^https?:\/\//.test(target) && !target.startsWith(`${PRIVATE_HOST}/`)) {
    fail(`not a wovn file host URL: ${target}`);
  }
  const key = target.startsWith(`${PRIVATE_HOST}/`) ? target.slice(PRIVATE_HOST.length + 1) : target;
  return { host: PRIVATE_HOST, key, headers: accessHeaders(reason) };
}

async function read(target: string): Promise<void> {
  const { host, key, headers } = resolveTarget(target, "reading private files");
  const res = await fetch(`${host}/${key}`, { headers });
  if (!res.ok) fail(`read failed (${res.status}): ${(await res.text()).trim()}`);
  if (res.body) await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), process.stdout, { end: false });
}

interface FileVersion {
  key: string;
  size: number;
  uploaded: string;
}

interface FileHistory {
  current: FileVersion | null;
  versions: FileVersion[]; // archived previous versions, newest first
}

// History is authenticated on both hosts, like listing: Access covers the
// private host, the upload token covers the public one.
async function fetchHistory(target: string): Promise<{ host: string; key: string; history: FileHistory }> {
  const { host, key, headers } = resolveTarget(target, "history");
  if (host === HOST) headers.authorization = `Bearer ${token()}`;
  const res = await fetch(`${host}/${key}?history`, { headers });
  if (!res.ok) fail(`history failed (${res.status}): ${(await res.text()).trim()}`);
  return { host, key, history: (await res.json()) as FileHistory };
}

async function history(target: string): Promise<void> {
  const { host, key, history } = await fetchHistory(target);
  if (!history.current && history.versions.length === 0) fail(`${host}/${key} not found`);
  if (history.current) {
    console.log(
      `${formatWhen(history.current.uploaded)}  ${formatSize(history.current.size).padStart(9)}  current  ${host}/${history.current.key}`,
    );
  }
  for (const version of history.versions) {
    console.log(
      `${formatWhen(version.uploaded)}  ${formatSize(version.size).padStart(9)}           ${host}/${version.key}`,
    );
  }
}

// The filename a version renders as in the diff: archive keys are
// archive/<stable-path>/<stamp>, so the name is the stable path's last segment.
function displayName(key: string): string {
  const segments = key.split("/").filter(Boolean);
  if (segments[0] === "archive" && segments.length >= 3) return segments[segments.length - 2];
  return segments[segments.length - 1] ?? "file";
}

async function fetchToFile(target: string, dir: string, side: "old" | "new"): Promise<string> {
  const { host, key, headers } = resolveTarget(target, "diff");
  const res = await fetch(`${host}/${key}`, { headers });
  if (!res.ok) fail(`fetch failed for ${host}/${key} (${res.status}): ${(await res.text()).trim()}`);
  const rel = join(side, displayName(key));
  mkdirSync(join(dir, side), { recursive: true });
  writeFileSync(join(dir, rel), Buffer.from(await res.arrayBuffer()));
  return rel;
}

async function diff(oldTarget: string, newTarget: string | undefined): Promise<void> {
  // One argument = a stable path: diff its most recent archived version
  // against the current object.
  if (newTarget === undefined) {
    const { host, key, history } = await fetchHistory(oldTarget);
    if (!history.current) fail(`${host}/${key} not found`);
    if (history.versions.length === 0) fail(`${host}/${key} has no previous versions to diff against`);
    newTarget = `${host}/${history.current.key}`;
    oldTarget = `${host}/${history.versions[0].key}`;
  }
  const dir = mkdtempSync(join(tmpdir(), "wovn-diff-"));
  try {
    const oldRel = await fetchToFile(oldTarget, dir, "old");
    const newRel = await fetchToFile(newTarget, dir, "new");
    // git diff --no-index exits 0 when identical, 1 when the files differ.
    const result = spawnSync("git", ["diff", "--no-index", oldRel, newRel], { cwd: dir, stdio: "inherit" });
    if (result.status === 0) console.error("wovn: no differences");
    else if (result.status !== 1) fail("git diff failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rotate(): void {
  const next = randomBytes(32).toString("hex");
  // Server first: if the secret update fails, the local token stays valid.
  const result = spawnSync(
    "npx",
    ["-y", "wrangler", "secret", "put", "FILE_HOST_TOKEN", "--name", "wovn-files"],
    {
      input: next,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    },
  );
  if (result.status !== 0) fail("wrangler secret put failed; local token is unchanged");
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `${next}\n`, { mode: 0o600 });
  console.log(`wovn: token rotated (${TOKEN_FILE} and the Worker secret are updated)`);
  console.log("wovn: shells with a stale FILE_HOST_TOKEN env var need restarting; wovn itself reads the file");
}

const program = new Command("wovn").description("CLI for the files.wovn.org file host");

program
  .command("put")
  .description("upload files and print one permanent URL per line")
  .argument("<file...>", "local file(s) to upload")
  .option("--private", "upload to private.wovn.org (Access-gated; only Connor can read)")
  .option("--name <filename>", "filename for the generated URL (single file only)")
  .option("--at <remote-path>", "write to a stable path instead of a generated key; the URL never changes")
  .option("--force", "with --at, replace an existing object at that path")
  .action(put);

program
  .command("list")
  .description("list recent files on both hosts, newest first")
  .option("--public", "only list files.wovn.org")
  .option("--private", "only list private.wovn.org")
  .option("-n, --limit <count>", "max files to show", "20")
  .option("--project [name-or-path]", "only files uploaded from this project (default: the current one)")
  .option("--branch [branch]", "only files uploaded from this git branch (default: the current one)")
  .option("--worktree [path]", "only files uploaded from this git worktree (default: the current one)")
  .option("--dir [path]", "only files uploaded from this directory (default: the current one)")
  .option(
    "--type <types>",
    `only files of these types: a category (${TYPE_CATEGORIES.join(", ")}) or a file extension, comma-separated or repeated`,
    collectTypes,
  )
  .action(list);

program
  .command("read")
  .description("print a hosted file to stdout; bare paths read the private host")
  .argument("<url-or-path>", "wovn URL, or a path on the private host")
  .action(read);

program
  .command("history")
  .description("list all versions of a stable path, newest first")
  .argument("<url-or-path>", "wovn URL, or a path on the private host")
  .action(history);

program
  .command("diff")
  .description("git-diff two hosted files; with one argument, diff a stable path's previous version against its current one")
  .argument("<old>", "wovn URL or private-host path (the stable path, when used alone)")
  .argument("[new]", "wovn URL or private-host path")
  .action(diff);

program
  .command("rotate")
  .description("rotate the upload token (file + Worker secret)")
  .action(rotate);

program.parseAsync().catch((error: unknown) => {
  // Surface the cause: undici wraps network errors in a bare "fetch failed".
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    fail(`${error.message}${cause}`);
  }
  fail(String(error));
});
