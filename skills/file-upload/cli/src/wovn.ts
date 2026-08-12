// wovn - CLI for the files.wovn.org file host (see skills/file-upload).
//
// --private uploads to private.wovn.org (Cloudflare Access-gated; only Connor
// can read) using the Access service token in ~/.config/wovn-files/access.env.
//
// Token resolution: ~/.config/wovn-files/token.txt first (canonical on this
// machine, survives rotation without a new shell), FILE_HOST_TOKEN env second
// (for machines that only have the env var).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openAsBlob, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

interface ListOptions {
  public?: true;
  private?: true;
  limit: string;
}

async function list(opts: ListOptions): Promise<void> {
  if (opts.public && opts.private) fail("--public and --private are mutually exclusive");
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");

  const hosts: { host: string; headers: Record<string, string> }[] = [];
  if (!opts.private) hosts.push({ host: HOST, headers: { authorization: `Bearer ${token()}` } });
  if (!opts.public) hosts.push({ host: PRIVATE_HOST, headers: accessHeaders("listing private files") });

  const entries = (
    await Promise.all(
      hosts.map(async ({ host, headers }) => {
        const res = await fetch(`${host}/?list&limit=${limit}`, { headers });
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

async function read(target: string): Promise<void> {
  let url = target;
  let headers: Record<string, string> = {};
  if (target.startsWith(`${HOST}/`)) {
    // Public URLs need no auth.
  } else if (/^https?:\/\//.test(target) && !target.startsWith(`${PRIVATE_HOST}/`)) {
    fail(`not a wovn file host URL: ${target}`);
  } else {
    // Bare paths read from the private host; public URLs need no CLI anyway.
    if (!target.startsWith(`${PRIVATE_HOST}/`)) url = `${PRIVATE_HOST}/${target}`;
    headers = accessHeaders("reading private files");
  }
  const res = await fetch(url, { headers });
  if (!res.ok) fail(`read failed (${res.status}): ${(await res.text()).trim()}`);
  if (res.body) await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), process.stdout, { end: false });
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
  .action(list);

program
  .command("read")
  .description("print a hosted file to stdout; bare paths read the private host")
  .argument("<url-or-path>", "wovn URL, or a path on the private host")
  .action(read);

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
