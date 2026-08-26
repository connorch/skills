// wovn - CLI for the files.wovn.org file host (see skills/wovn-file-hosting).
//
// One host, one credential: every request authenticates with the WOVN_TOKEN
// bearer token. Files are private by default; `--public` (or
// `wovn visibility set <path> public`) makes one public. Browser access to
// private files goes through the host's /login flow instead - the CLI never
// needs Cloudflare Access credentials.
//
// Token resolution: ~/.config/wovn-files/token.txt first (canonical on this
// machine, survives rotation without a new shell), WOVN_TOKEN env second
// (for machines that only have the env var).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";

// WOVN_HOST is a test hook for pointing at wrangler dev.
const HOST = process.env.WOVN_HOST ?? "https://files.wovn.org";
const TOKEN_FILE = join(homedir(), ".config", "wovn-files", "token.txt");
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
    const env = process.env.WOVN_TOKEN;
    if (env) return env;
    fail(`no token at ${TOKEN_FILE} and WOVN_TOKEN is unset`);
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token()}` };
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
  public?: true;
  private?: true;
  name?: string;
  at?: string;
  force?: true;
}

async function put(files: string[], opts: PutOptions): Promise<void> {
  if (opts.public && opts.private) fail("--public and --private are mutually exclusive");
  if (opts.name !== undefined && files.length > 1) fail("--name only applies to a single file");
  if (opts.at !== undefined && files.length > 1) fail("--at only applies to a single file");
  if (opts.at !== undefined && opts.name !== undefined) fail("--at already names the file; drop --name");
  if (opts.force && opts.at === undefined) fail("--force only applies to --at uploads");

  const headers: Record<string, string> = authHeaders();
  if (opts.force) headers["x-wovn-force"] = "1";
  // Fail closed: uploads are private unless --public. The explicit values
  // matter on forced overwrites, where the server otherwise preserves the
  // existing object's visibility (updating a published doc keeps it public).
  if (opts.public) headers["x-wovn-visibility"] = "public";
  else if (opts.private) headers["x-wovn-visibility"] = "private";

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
    const res = await fetch(`${HOST}/${path}`, { method, headers, body: blob });
    const body = await res.text();
    if (res.status === 409) fail(`${HOST}/${path} already exists; pass --force to replace it`);
    if (!res.ok) fail(`upload failed (${res.status}): ${body.trim()}`);
    process.stdout.write(body);
  }
}

interface ListEntry {
  key: string;
  size: number;
  uploaded: string;
  visibility: "public" | "private";
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

  const query = new URLSearchParams({ limit: String(limit) });
  if (opts.public) query.set("visibility", "public");
  if (opts.private) query.set("visibility", "private");
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

  const res = await fetch(`${HOST}/api/files?${query}`, { headers: authHeaders() });
  if (!res.ok) fail(`list failed (${res.status}): ${(await res.text()).trim()}`);
  const { files } = (await res.json()) as { files: ListEntry[] };
  for (const entry of files) {
    const tag = entry.visibility === "public" ? "pub" : "prv";
    console.log(
      `${formatWhen(entry.uploaded)}  ${formatSize(entry.size).padStart(9)}  ${tag}  ${HOST}/${entry.key}`,
    );
  }
}

// A target is a wovn URL or a bare key path; both name the same File on the
// single host. A pasted Version alias URL (/<key>/archive[/<stamp>]) resolves
// to the Stable Path it belongs to, so `wovn history` and `wovn diff` accept
// those URLs; real archive/... keys pass through untouched.
function resolveKey(target: string): string {
  let key = target;
  if (target.startsWith(`${HOST}/`)) key = target.slice(HOST.length + 1);
  else if (/^https?:\/\//.test(target)) fail(`not a ${HOST} URL: ${target}`);
  key = key.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!key.startsWith("archive/")) key = key.replace(/\/archive(\/[^/]+)?$/, "");
  return key;
}

async function read(target: string): Promise<void> {
  const key = resolveKey(target);
  const res = await fetch(`${HOST}/${key}`, { headers: authHeaders() });
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

async function fetchHistory(target: string): Promise<{ key: string; history: FileHistory }> {
  const key = resolveKey(target);
  const res = await fetch(`${HOST}/api/versions/${key}`, { headers: authHeaders() });
  if (!res.ok) fail(`history failed (${res.status}): ${(await res.text()).trim()}`);
  return { key, history: (await res.json()) as FileHistory };
}

async function history(target: string): Promise<void> {
  const { key, history } = await fetchHistory(target);
  if (!history.current && history.versions.length === 0) fail(`${HOST}/${key} not found`);
  if (history.current) {
    console.log(
      `${formatWhen(history.current.uploaded)}  ${formatSize(history.current.size).padStart(9)}  current  ${HOST}/${history.current.key}`,
    );
  }
  for (const version of history.versions) {
    console.log(
      `${formatWhen(version.uploaded)}  ${formatSize(version.size).padStart(9)}           ${HOST}/${version.key}`,
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
  const key = resolveKey(target);
  const res = await fetch(`${HOST}/${key}`, { headers: authHeaders() });
  if (!res.ok) fail(`fetch failed for ${HOST}/${key} (${res.status}): ${(await res.text()).trim()}`);
  const rel = join(side, displayName(key));
  mkdirSync(join(dir, side), { recursive: true });
  writeFileSync(join(dir, rel), Buffer.from(await res.arrayBuffer()));
  return rel;
}

async function diff(oldTarget: string, newTarget: string | undefined): Promise<void> {
  // One argument = a stable path: diff its most recent archived version
  // against the current object.
  if (newTarget === undefined) {
    const { key, history } = await fetchHistory(oldTarget);
    if (!history.current) fail(`${HOST}/${key} not found`);
    if (history.versions.length === 0) fail(`${HOST}/${key} has no previous versions to diff against`);
    newTarget = history.current.key;
    oldTarget = history.versions[0].key;
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

async function visibilityGet(target: string): Promise<void> {
  const key = resolveKey(target);
  const res = await fetch(`${HOST}/api/files/${key}`, { headers: authHeaders() });
  if (!res.ok) fail(`visibility get failed (${res.status}): ${(await res.text()).trim()}`);
  const { visibility } = (await res.json()) as { visibility: string };
  console.log(visibility);
}

async function visibilitySet(target: string, value: string): Promise<void> {
  if (value !== "public" && value !== "private") fail("visibility must be public or private");
  const key = resolveKey(target);
  const res = await fetch(`${HOST}/api/files/${key}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ visibility: value }),
  });
  if (!res.ok) fail(`visibility set failed (${res.status}): ${(await res.text()).trim()}`);
  console.log(`${HOST}/${key}`);
}

async function rm(targets: string[]): Promise<void> {
  for (const target of targets) {
    const key = resolveKey(target);
    const res = await fetch(`${HOST}/api/files/${key}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) fail(`rm failed for ${HOST}/${key} (${res.status}): ${(await res.text()).trim()}`);
    const { deleted } = (await res.json()) as { deleted: string[] };
    for (const deletedKey of deleted) console.log(`deleted ${HOST}/${deletedKey}`);
  }
}

function rotate(): void {
  const next = randomBytes(32).toString("hex");
  // Server first: if the secret update fails, the local token stays valid.
  const result = spawnSync(
    "npx",
    ["-y", "wrangler", "secret", "put", "WOVN_TOKEN", "--name", "wovn-files"],
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
  console.log("wovn: shells with a stale WOVN_TOKEN env var need restarting; wovn itself reads the file");
}

const program = new Command("wovn").description("CLI for the files.wovn.org file host");

program
  .command("put")
  .description("upload files (private by default) and print one permanent URL per line")
  .argument("<file...>", "local file(s) to upload")
  .option("--public", "make the upload publicly readable")
  .option("--private", "keep the upload private (the default; explicit on overwrites)")
  .option("--name <filename>", "filename for the generated URL (single file only)")
  .option("--at <remote-path>", "write to a stable path instead of a generated key; the URL never changes")
  .option("--force", "with --at, replace an existing object at that path")
  .action(put);

program
  .command("list")
  .description("list recent files, newest first")
  .option("--public", "only public files")
  .option("--private", "only private files")
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
  .description("print a hosted file to stdout")
  .argument("<url-or-path>", "wovn URL or key path")
  .action(read);

program
  .command("history")
  .description("list all versions of a stable path, newest first")
  .argument("<url-or-path>", "wovn URL or key path")
  .action(history);

program
  .command("diff")
  .description("git-diff two hosted files; with one argument, diff a stable path's previous version against its current one")
  .argument("<old>", "wovn URL or key path (the stable path, when used alone)")
  .argument("[new]", "wovn URL or key path")
  .action(diff);

const visibility = program
  .command("visibility")
  .description("read or change whether a file is public or private");
visibility
  .command("get")
  .description("print a file's visibility (public or private)")
  .argument("<url-or-path>", "wovn URL or key path")
  .action(visibilityGet);
visibility
  .command("set")
  .description("change a file's visibility; the URL never changes")
  .argument("<url-or-path>", "wovn URL or key path")
  .argument("<visibility>", "public or private")
  .action(visibilitySet);

program
  .command("rm")
  .description("delete files, including all archived versions of a stable path")
  .argument("<url-or-path...>", "wovn URL(s) or key path(s); an archive URL deletes just that version")
  .action(rm);

const tokenCommand = program.command("token").description("manage the WOVN_TOKEN credential");
tokenCommand
  .command("rotate")
  .description("rotate the token (file + Worker secret)")
  .action(rotate);

program.parseAsync().catch((error: unknown) => {
  // Surface the cause: undici wraps network errors in a bare "fetch failed".
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    fail(`${error.message}${cause}`);
  }
  fail(String(error));
});
