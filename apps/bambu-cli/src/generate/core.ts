import * as fs from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const formats = ["glb", "stl", "3mf", "obj"] as const;
export type OutputFormat = (typeof formats)[number];
export type State =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected";
export interface Status {
  state: State;
  progress: number | null;
  message: string;
  raw_status: string;
  outputs: Record<string, string>;
}
export interface ImageInput {
  name: string;
  url?: string;
  data?: Buffer;
  mime?: string;
}
export interface GenerationRequest {
  prompt?: string;
  image?: ImageInput;
  model?: string;
  output_format: OutputFormat;
  texture: boolean;
}
export interface FollowUp {
  key: string;
  action: string;
  source: TaskRef;
  description: string;
}
export interface Provider {
  name: string;
  image_prompt_supported: boolean;
  poll_interval_s: number;
  max_poll_interval_s: number;
  create(request: GenerationRequest): Promise<TaskRef>;
  poll(ref: TaskRef): Promise<Status>;
  followUp(
    ref: TaskRef,
    status: Status,
    format: OutputFormat,
    texture: boolean,
  ): FollowUp | undefined;
  startFollowUp(step: FollowUp): Promise<TaskRef>;
  download(
    ref: TaskRef,
    format: OutputFormat,
    dir: string,
  ): Promise<{ path: string; output_format: OutputFormat }>;
}
export class InputError extends Error {}
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly http_status?: number,
  ) {
    super(`${message} (${code})`);
  }
}
export function object(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new ProviderError("bad_response", "expected a JSON object");
  return parsed.data;
}
export function status(state: State, values: Partial<Omit<Status, "state">> = {}): Status {
  return { state, progress: null, message: "", raw_status: "", outputs: {}, ...values };
}
export function terminal(state: State): boolean {
  return state !== "queued" && state !== "running";
}

// Task tokens retain every provider id needed to resume in a different process.
export class TaskRef {
  constructor(
    readonly provider: string,
    readonly kind: string,
    readonly ids: string[],
  ) {
    if (
      ![provider, kind].every((v) => /^[a-z0-9-]{1,32}$/.test(v)) ||
      !ids.length ||
      ids.some((v) => !v.length || v.length > 4096)
    )
      throw new InputError("invalid task id");
  }
  get primary_id(): string {
    return this.ids[0]!;
  }
  get token(): string {
    return [
      this.provider,
      this.kind,
      ...this.ids.map((v) =>
        /^[A-Za-z0-9._=-]{1,4096}$/.test(v) ? v : `~${Buffer.from(v).toString("base64url")}`,
      ),
    ].join(":");
  }
  static parse(token: string): TaskRef {
    const [provider, kind, ...parts] = token.trim().split(":");
    if (!provider || !kind || !parts.length)
      throw new InputError("expected provider:kind:id task token");
    const ids = parts.map((part) => {
      if (!part.startsWith("~")) {
        if (!/^[A-Za-z0-9._=-]{1,4096}$/.test(part)) throw new InputError("invalid task id part");
        return part;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(part.slice(1))) throw new InputError("invalid encoded task id");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(part.slice(1), "base64url"),
        );
      } catch {
        throw new InputError("invalid encoded task id");
      }
    });
    return new TaskRef(provider, kind, ids);
  }
}
export function formatFromName(name: string): OutputFormat | undefined {
  return formats.find((f) => name.toLowerCase().split("?")[0]!.endsWith(`.${f}`));
}
export const sleep = async (seconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

// Only GET is retried; a failed POST may already have spent credits.
export class HttpClient {
  constructor(
    readonly fetcher: typeof fetch = fetch,
    readonly pause = sleep,
  ) {}
  async send(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let error: ProviderError;
      try {
        const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(70000) });
        if (response.status < 400) return response;
        let body: Record<string, unknown> = {};
        const text = await response.text();
        try {
          body = object(JSON.parse(text));
        } catch {
          /* Non-JSON error pages still carry an HTTP status. */
        }
        const message = String(body.message || text.slice(0, 200) || response.statusText);
        error = new ProviderError(
          String(body.error || body.code || `http_${response.status}`),
          `HTTP ${response.status}: ${message}${body.suggestion ? `. ${String(body.suggestion)}` : ""}`,
          response.status >= 500 || response.status === 429,
          response.status,
        );
      } catch (cause) {
        error =
          cause instanceof ProviderError
            ? cause
            : new ProviderError("network", "network request connection failed", true);
      }
      if (
        (init.method ?? "GET") !== "GET" ||
        attempt >= 2 ||
        (error.http_status !== undefined && error.http_status < 500)
      )
        throw error;
      await this.pause(Math.min(2 * 2 ** attempt, 30));
    }
  }
  async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.send(url, init);
    try {
      return await response.json();
    } catch {
      throw new ProviderError(
        "bad_response",
        `expected JSON from ${url.split("?")[0]}`,
        true,
        response.status,
      );
    }
  }
}
export function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}
export function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
}
export function loadImage(value: string, io = fs): ImageInput {
  if (isUrl(value)) return { name: basename(new URL(value).pathname) || "image", url: value };
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!io.existsSync(path) || !io.statSync(path).isFile())
    throw new InputError(`image not found: ${path}`);
  if (io.statSync(path).size > 20 * 1024 * 1024)
    throw new InputError("providers accept up to 20 MB");
  const data = io.readFileSync(path);
  const mime = imageMime(data);
  if (!mime) throw new InputError(`${basename(path)} is not a PNG, JPEG or WebP image`);
  return { name: basename(path), data, mime };
}
export function uploadName(image: ImageInput): string {
  return `${basename(image.name, extname(image.name)) || "image"}.${image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png"}`;
}

// Atomic ledger writes remember paid follow-ups before subsequent polling begins.
export class FollowUpLedger {
  private steps = new Map<string, string>();
  constructor(
    readonly path?: string,
    private readonly io = fs,
  ) {
    if (path)
      try {
        const doc = object(JSON.parse(io.readFileSync(path, "utf8")));
        for (const [key, value] of Object.entries(object(doc.steps)))
          if (typeof value === "string") this.steps.set(key, value);
      } catch {
        /* Upstream ignores missing or corrupt ledgers. */
      }
  }
  get(key: string): string | undefined {
    return this.steps.get(key);
  }
  startedFrom(token: string): string | undefined {
    return [...this.steps].toReversed().find(([key]) => key.startsWith(`${token}>`))?.[1];
  }
  record(key: string, token: string): void {
    this.steps.delete(key);
    this.steps.set(key, token);
    while (this.steps.size > 500) this.steps.delete(this.steps.keys().next().value!);
    if (!this.path) return;
    this.io.mkdirSync(dirname(this.path), { recursive: true });
    this.io.writeFileSync(
      `${this.path}.tmp`,
      JSON.stringify({ version: 1, steps: Object.fromEntries(this.steps) }, null, 1),
    );
    this.io.renameSync(`${this.path}.tmp`, this.path);
  }
}
