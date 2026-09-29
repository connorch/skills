// The proxy. Inference requests (POST /v1/messages*) are routed across
// accounts; everything else is forwarded with the client's own auth. Bytes
// reach the client only once an account has answered with a status that
// does not fail over, so a failover is invisible to it.

import { createHash } from "node:crypto";
import {
  Agent as HttpAgent,
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Account } from "./accounts.ts";
import { candidate, recordResponse, type AccountState, type Candidate } from "./buckets.ts";
import type { Config } from "./config.ts";
import { select, type Selection } from "./select.ts";
import type { LogEntry, RequestLog, RouterState } from "./state.ts";
import { classify, retryAfterSeconds, type Mark } from "./upstream-errors.ts";

export interface RouterDeps {
  config: Config;
  // Current accounts; re-read after `accounts sync` signals a reload.
  accounts: () => Account[];
  reload: () => void;
  state: RouterState;
  log: RequestLog;
  now?: () => number;
}

export const FORCE_HEADER = "x-claude-router-account";
const HINT =
  "claude-router: `claude-router status` shows account state; `claude-direct` bypasses the router.";

// Never forwarded upstream: hop-by-hop, the host we replace, the length we
// recompute, and the router's own header.
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  FORCE_HEADER,
]);
// A routed request carries exactly one credential: the account's token.
const DROP_ROUTED = new Set([...DROP_REQUEST, "authorization", "x-api-key"]);
// Node manages these on the relayed response.
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding"]);

const ORG_BLOCK_BASE_MS = 5 * 60_000;
const ORG_BLOCK_MAX_MS = 6 * 3_600_000;
const TRANSIENT_BENCH_MS = 60_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;

function filterHeaders(headers: IncomingHttpHeaders, drop: Set<string>): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop.has(name) && value !== undefined) out[name] = value;
  }
  return out;
}

// `claude-cli/2.1.284 (external, claude-desktop, agent-sdk/0.3.276)` -> claude-desktop
export function entrypointOf(userAgent: string | undefined): string | null {
  const match = userAgent && /\(external, ([^,)]+)/.exec(userAgent);
  return match ? (match[1] ?? null) : null;
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

function parseRequest(body: Buffer): { model: string | null; key: string | null } {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return { model: null, key: null };
    const { model, metadata } = parsed as { model?: unknown; metadata?: { user_id?: unknown } };
    return {
      model: typeof model === "string" ? model : null,
      key: typeof metadata?.user_id === "string" ? metadata.user_id : null,
    };
  } catch {
    return { model: null, key: null };
  }
}

function readBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

interface Upstream {
  status: number;
  headers: IncomingHttpHeaders;
  res: IncomingMessage;
}

export function createRouter(deps: RouterDeps): Server {
  const { config, state, log } = deps;
  const now = deps.now ?? Date.now;
  const upstream = new URL(config.upstream);
  const secure = upstream.protocol === "https:";
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  const request = secure ? httpsRequest : httpRequest;

  // The client's response: while it is open, `inflight` is the upstream
  // request feeding it, so an abort can cancel that request. A client that
  // hangs up mid-generation must not leave a generation running upstream.
  interface Link {
    res: ServerResponse;
    inflight: ClientRequest | null;
  }

  function link(res: ServerResponse): Link {
    const l: Link = { res, inflight: null };
    res.on("close", () => {
      if (!res.writableFinished) l.inflight?.destroy();
    });
    return l;
  }

  function send(
    l: Link,
    method: string,
    path: string,
    headers: OutgoingHttpHeaders,
    body: Buffer,
    token: string | null,
  ): Promise<Upstream> {
    return new Promise((resolve, reject) => {
      if (l.res.destroyed) return reject(new Error("client went away"));
      const outgoing: OutgoingHttpHeaders = {
        ...headers,
        host: upstream.host,
        "content-length": String(body.length),
      };
      if (token) outgoing.authorization = `Bearer ${token}`;
      const req = request(
        {
          agent,
          method,
          hostname: upstream.hostname,
          port: upstream.port || (secure ? 443 : 80),
          path,
          headers: outgoing,
        },
        (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, res }),
      );
      req.on("error", reject);
      req.on("close", () => {
        if (l.inflight === req) l.inflight = null;
      });
      l.inflight = req;
      req.end(body);
    });
  }

  // Stream an upstream response to the client. A client that goes away
  // takes the upstream request down with it.
  function relay(up: Upstream, res: ServerResponse): void {
    if (res.destroyed) {
      up.res.destroy();
      return;
    }
    res.writeHead(up.status, filterHeaders(up.headers, DROP_RESPONSE));
    up.res.pipe(res);
    res.on("close", () => {
      if (!res.writableFinished) up.res.destroy();
    });
  }

  function respond(
    res: ServerResponse,
    status: number,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ) {
    if (res.destroyed) return;
    res.writeHead(status, {
      ...filterHeaders(headers, DROP_RESPONSE),
      "content-length": body.length,
    });
    res.end(body);
  }

  function json(res: ServerResponse, status: number, value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  }

  function routerError(res: ServerResponse, status: number, type: string, message: string) {
    json(res, status, { type: "error", error: { type, message: `${message} ${HINT}` } });
  }

  function applyMark(st: AccountState, mark: Mark, headers: IncomingHttpHeaders, at: number) {
    switch (mark) {
      case "broken":
        st.broken = { reason: "401", since: at };
        break;
      case "org_block": {
        const attempts = (st.bench?.reason === "org_block" ? st.bench.attempts : 0) + 1;
        const wait = Math.min(ORG_BLOCK_BASE_MS * 2 ** (attempts - 1), ORG_BLOCK_MAX_MS);
        st.bench = { until: at + wait, reason: "org_block", attempts, probing: false };
        break;
      }
      case "transient":
        st.bench = {
          until: at + TRANSIENT_BENCH_MS,
          reason: "transient",
          attempts: 0,
          probing: false,
        };
        break;
      case "retry_after": {
        const seconds = retryAfterSeconds(headers) ?? TRANSIENT_BENCH_MS / 1000;
        const wait = Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
        st.bench = { until: at + wait, reason: "retry_after", attempts: 0, probing: false };
        break;
      }
      case "limit":
      case null:
        break;
    }
  }

  async function passthrough(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    entry: Omit<LogEntry, "kind" | "status">,
  ) {
    const l = link(res);
    try {
      const up = await send(
        l,
        req.method ?? "GET",
        req.url ?? "/",
        filterHeaders(req.headers, DROP_REQUEST),
        body,
        null,
      );
      log.append({ ...entry, kind: "passthrough", status: up.status });
      relay(up, res);
    } catch (error) {
      if (res.destroyed) {
        return log.append({
          ...entry,
          kind: "router_error",
          status: 499,
          reason: "client went away",
        });
      }
      log.append({ ...entry, kind: "router_error", status: 502 });
      routerError(res, 502, "api_error", `upstream unreachable: ${(error as Error).message}.`);
    }
  }

  function candidatesFor(accounts: Account[], model: string | null, at: number): Candidate[] {
    return accounts.map((a) => candidate(a.label, state.account(a.label), model, config, at));
  }

  async function route(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const at = now();
    state.prunePins(at, config.pinIdleMs);
    const { model, key } = parseRequest(body);
    const entrypoint = entrypointOf(req.headers["user-agent"]);
    const entry = {
      time: new Date(at).toISOString(),
      path: req.url ?? "/",
      model,
      key: key ? hashKey(key) : null,
      entrypoint,
    };

    if (entrypoint && config.passthroughEntrypoints.includes(entrypoint)) {
      return passthrough(req, res, body, {
        ...entry,
        reason: `passthrough entrypoint ${entrypoint}`,
      });
    }
    const accounts = deps.accounts();
    if (accounts.length === 0) {
      return passthrough(req, res, body, { ...entry, reason: "no accounts, fail open" });
    }
    const byLabel = new Map(accounts.map((a) => [a.label, a]));
    const forcedHeader = req.headers[FORCE_HEADER];
    const forced = Array.isArray(forcedHeader) ? (forcedHeader[0] ?? null) : (forcedHeader ?? null);
    if (forced && !byLabel.has(forced)) {
      log.append({
        ...entry,
        kind: "router_error",
        status: 400,
        reason: `unknown forced account ${forced}`,
      });
      return routerError(
        res,
        400,
        "invalid_request_error",
        `unknown ${FORCE_HEADER} "${forced}"; known accounts: ${[...byLabel.keys()].join(", ")}.`,
      );
    }

    const pin = key ? state.pins[key] : undefined;
    const selection: Selection = select({
      candidates: candidatesFor(accounts, model, at),
      pin,
      forced,
      pinIdleMs: config.pinIdleMs,
      now: at,
    });
    if (!key && !forced) selection.reason = "no session key";

    const headers = filterHeaders(req.headers, DROP_ROUTED);
    const method = req.method ?? "POST";
    const path = req.url ?? "/";
    const l = link(res);
    const attempts: string[] = [];
    let firstError: { status: number; headers: IncomingHttpHeaders; body: Buffer } | null = null;

    for (const label of selection.order) {
      const account = byLabel.get(label);
      if (!account) continue;
      const st = state.account(label);
      // One probe through an expired org block. Whatever comes back other
      // than another block ends the bench, so a 429 or an abort cannot leave
      // the account marked "probe in flight" forever.
      if (st.bench?.reason === "org_block" && at >= st.bench.until) st.bench.probing = true;
      const endProbe = () => {
        if (st.bench?.probing) st.bench = null;
      };
      const gone = () => {
        endProbe();
        log.append({
          ...entry,
          kind: "router_error",
          status: 499,
          attempts,
          reason: "client went away",
        });
      };
      let retried = false;
      for (;;) {
        attempts.push(label);
        let up: Upstream;
        try {
          up = await send(l, method, path, headers, body, account.token);
        } catch (error) {
          if (res.destroyed) return gone();
          if (!retried) {
            retried = true;
            continue;
          }
          applyMark(st, "transient", {}, at);
          endProbe();
          firstError ??= {
            status: 502,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: `upstream unreachable: ${(error as Error).message}. ${HINT}`,
                },
              }),
            ),
          };
          break;
        }
        recordResponse(st, model, up.headers, at);
        if (res.destroyed) {
          up.res.destroy();
          return gone();
        }
        const needsBody =
          up.status === 401 || up.status === 403 || up.status === 429 || up.status >= 500;
        const errorBody = needsBody ? await readBody(up.res) : null;
        const verdict = classify({
          status: up.status,
          headers: up.headers,
          body: errorBody?.toString("utf8") ?? null,
          retried,
        });
        if (verdict.kind === "retry") {
          retried = true;
          continue;
        }
        if (verdict.kind === "failover") applyMark(st, verdict.mark, up.headers, at);
        endProbe();
        // A forced account answers for itself, limit errors included (D12).
        if (verdict.kind === "commit" || forced) {
          if (key) state.pins[key] = { label, lastSeen: at };
          state.touch();
          log.append({
            ...entry,
            kind: "routed",
            account: label,
            status: up.status,
            attempts,
            reason: selection.reason,
            forced: Boolean(forced),
          });
          if (errorBody) respond(res, up.status, up.headers, errorBody);
          else relay(up, res);
          return;
        }
        firstError ??= {
          status: up.status,
          headers: up.headers,
          body: errorBody ?? Buffer.alloc(0),
        };
        break;
      }
    }

    state.touch();
    if (firstError) {
      log.append({
        ...entry,
        kind: "routed",
        status: firstError.status,
        attempts,
        reason: `${selection.reason}; all failed`,
      });
      return respond(res, firstError.status, firstError.headers, firstError.body);
    }
    log.append({ ...entry, kind: "router_error", status: 503, reason: "no account to try" });
    routerError(res, 503, "api_error", "no account could serve this request.");
  }

  // What `claude-router status` prints: per account buckets and token expiry,
  // the ranking for every model seen, and active pins.
  function snapshot() {
    const at = now();
    state.prunePins(at, config.pinIdleMs);
    const accounts = deps.accounts();
    const known = new Set(accounts.map((a) => a.label));
    const models = [
      ...new Set(accounts.flatMap((a) => Object.keys(state.account(a.label).modelBuckets))),
    ].sort();
    return {
      now: new Date(at).toISOString(),
      upstream: config.upstream,
      missing: config.accounts.filter((label) => !known.has(label)),
      accounts: accounts.map((a) => {
        const st = state.account(a.label);
        return {
          label: a.label,
          expires: a.expires,
          broken: st.broken,
          bench: st.bench,
          buckets: st.buckets,
        };
      }),
      ranking: Object.fromEntries(
        models.map((model) => [
          model,
          candidatesFor(accounts, model, at).length > 0
            ? {
                order: select({
                  candidates: candidatesFor(accounts, model, at),
                  pin: undefined,
                  forced: null,
                  pinIdleMs: config.pinIdleMs,
                  now: at,
                }).order,
                candidates: candidatesFor(accounts, model, at),
              }
            : { order: [], candidates: [] },
        ]),
      ),
      pins: Object.entries(state.pins).map(([key, pin]) => ({ key: hashKey(key), ...pin })),
    };
  }

  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      if (req.method === "GET" && url === "/health") {
        return json(res, 200, {
          ok: true,
          accounts: deps.accounts().map((a) => a.label),
          upstream: config.upstream,
        });
      }
      if (req.method === "GET" && url === "/_router/status") return json(res, 200, snapshot());
      if (req.method === "POST" && url === "/_router/reload") {
        deps.reload();
        return json(res, 200, { ok: true, accounts: deps.accounts().map((a) => a.label) });
      }
      const body = await readBody(req);
      if (req.method === "POST" && url.startsWith("/v1/messages"))
        return await route(req, res, body);
      return await passthrough(req, res, body, {
        time: new Date(now()).toISOString(),
        path: url,
        model: null,
        key: null,
        entrypoint: entrypointOf(req.headers["user-agent"]),
        reason: "not an inference path",
      });
    } catch (error) {
      if (!res.headersSent)
        routerError(res, 500, "api_error", `router failure: ${(error as Error).message}.`);
      else res.destroy();
    }
  });
}
