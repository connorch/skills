import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Account } from "./accounts.ts";
import { fixture } from "./buckets.test.ts";
import { Config } from "./config.ts";
import { createRouter } from "./server.ts";
import { RequestLog, RouterState } from "./state.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
interface Seen {
  auth: string | undefined;
  path: string;
  ua: string | undefined;
  forced: string | undefined;
  body: string;
}

// A scripted upstream: handlers are consumed in order, then `fallback` answers.
class Upstream {
  server: Server;
  seen: Seen[] = [];
  queue: Handler[] = [];
  fallback: Handler = (_req, res) =>
    reply(res, 200, { "content-type": "application/json" }, '{"ok":true}');

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        this.seen.push({
          auth: req.headers.authorization,
          path: req.url ?? "",
          ua: req.headers["user-agent"],
          forced: req.headers["x-claude-router-account"] as string | undefined,
          body,
        });
        (this.queue.shift() ?? this.fallback)(req, res, body);
      });
    });
  }
}

const reply = (
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
) => {
  res.writeHead(status, headers);
  res.end(body);
};
const fromFixture =
  (name: string): Handler =>
  (_req, res) => {
    const f = fixture(name);
    reply(res, f.status, f.headers, f.body ?? '{"ok":true}');
  };
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

const accounts: Account[] = [
  { label: "personal", token: "tok-personal", expires: null },
  { label: "personal_2", token: "tok-personal_2", expires: null },
  { label: "work", token: "tok-work", expires: null },
];
const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const UA = "claude-cli/2.1.284 (external, cli)";

let upstream: Upstream;
let router: Server;
let routerUrl: string;
let state: RouterState;
let log: RequestLog;
let live = accounts;

beforeEach(async () => {
  upstream = new Upstream();
  const port = await listen(upstream.server);
  state = new RouterState(null);
  log = new RequestLog(null);
  live = accounts;
  router = createRouter({
    config: Config.parse({ upstream: `http://127.0.0.1:${port}` }),
    accounts: () => live,
    reload: () => {},
    state,
    log,
    now: () => NOW,
  });
  routerUrl = `http://127.0.0.1:${await listen(router)}`;
});

afterEach(() => {
  router.close();
  upstream.server.close();
});

const messages = (body: object, headers: Record<string, string> = {}) =>
  fetch(`${routerUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer client-token",
      "user-agent": UA,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const session = (id: string, model = "claude-sonnet-5-5") => ({
  model,
  metadata: { user_id: `user_x_session_${id}` },
});

describe("routing", () => {
  it("ranks new sessions onto the soonest weekly reset and pins them", async () => {
    // Seed bucket state: personal's 7d resets Oct 2 (fable-200 fixture),
    // personal_2's resets Oct 1 (sonnet-200 fixture), work has no data.
    upstream.queue.push(fromFixture("fable-200"), fromFixture("sonnet-200"));
    await messages(session("seed1"), { "x-claude-router-account": "personal" });
    await messages(session("seed2"), { "x-claude-router-account": "personal_2" });
    expect(upstream.seen.map((s) => s.auth)).toEqual([
      "Bearer tok-personal",
      "Bearer tok-personal_2",
    ]);

    // personal_2 has the sooner reset, so a fresh session lands there.
    await messages(session("fresh"));
    expect(upstream.seen.at(-1)?.auth).toBe("Bearer tok-personal_2");
    expect(state.pins["user_x_session_fresh"]?.label).toBe("personal_2");
    expect(log.entries.at(-1)).toMatchObject({
      kind: "routed",
      account: "personal_2",
      reason: "new session",
      key: expect.any(String),
    });
    expect(log.entries.at(-1)?.key).not.toContain("session_fresh");
  });

  it("fails over on a limit 429 before the client sees anything, and re-pins the session", async () => {
    await messages(session("s"), { "x-claude-router-account": "personal" });
    upstream.queue.push(fromFixture("fable-429-7d_oi-rejected"), (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.end("event: message_stop\ndata: {}\n\n"), 20);
    });
    const res = await messages(session("s", "claude-fable-5-1"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_stop");
    expect(upstream.seen.slice(-2).map((s) => s.auth)).toEqual([
      "Bearer tok-personal",
      "Bearer tok-personal_2",
    ]);
    expect(state.pins["user_x_session_s"]?.label).toBe("personal_2");
    expect(log.entries.at(-1)).toMatchObject({ attempts: ["personal", "personal_2"], status: 200 });

    // The Fable bucket on personal is now blocked; Sonnet on personal is not.
    upstream.queue.push(fromFixture("sonnet-200"));
    await messages(session("t"), { "x-claude-router-account": "personal" });
    expect(upstream.seen.at(-1)?.auth).toBe("Bearer tok-personal");
    const status = (await (await fetch(`${routerUrl}/_router/status`)).json()) as {
      ranking: Record<string, { order: string[] }>;
    };
    expect(status.ranking["claude-fable-5-1"]?.order).not.toContain("personal");
    expect(status.ranking["claude-sonnet-5-5"]?.order).toContain("personal");
  });

  it("returns the first upstream error unchanged when every account fails", async () => {
    upstream.fallback = (_req, res) =>
      reply(
        res,
        429,
        { "content-type": "application/json", "x-should-retry": "true" },
        '{"first":true}',
      );
    const res = await messages(session("u"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ first: true });
    expect(upstream.seen).toHaveLength(3);
  });

  it("forces one account and hands its limit error back instead of switching", async () => {
    upstream.queue.push(fromFixture("fable-429-7d_oi-rejected"));
    const res = await messages(session("f", "claude-fable-5-1"), {
      "x-claude-router-account": "work",
    });
    expect(res.status).toBe(429);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]).toMatchObject({ auth: "Bearer tok-work", forced: undefined });

    const bad = await messages(session("f"), { "x-claude-router-account": "nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(
      /unknown x-claude-router-account "nope".*claude-router status/,
    );
    expect(upstream.seen).toHaveLength(1);
  });

  it("retries a 5xx once on the same account, then benches it and moves on", async () => {
    upstream.queue.push(
      (_req, res) => reply(res, 529, {}, "overloaded"),
      (_req, res) => reply(res, 529, {}, "overloaded"),
    );
    const res = await messages(session("o"));
    expect(res.status).toBe(200);
    const tried = upstream.seen.map((s) => s.auth);
    expect(tried).toHaveLength(3);
    expect(tried[0]).toBe(tried[1]);
    expect(tried[2]).not.toBe(tried[0]);
    expect(Object.values(state.accounts).some((a) => a.bench?.reason === "transient")).toBe(true);
  });

  it("cancels the upstream request when the client hangs up before headers arrive", async () => {
    let upstreamAborted = false;
    upstream.fallback = (req, res) => {
      req.on("close", () => (upstreamAborted = true));
      setTimeout(() => res.end("{}"), 500);
    };
    const controller = new AbortController();
    const req = fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(session("abort")),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await req;
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamAborted).toBe(true);
    expect(log.entries.some((e) => e.status === 499)).toBe(true);
    expect(Object.values(state.accounts).every((a) => a.bench === null)).toBe(true);
  });

  it("ends an org block once its probe gets any answer that is not another block", async () => {
    const block = JSON.stringify({
      type: "error",
      error: { type: "permission_error", message: "org" },
    });
    upstream.queue.push((_req, res) =>
      reply(res, 403, { "content-type": "application/json" }, block),
    );
    await messages(session("p1"), { "x-claude-router-account": "personal" });
    const bench = state.account("personal").bench;
    expect(bench).toMatchObject({ reason: "org_block", attempts: 1, probing: false });

    // Past the bench: the probe goes through, and a limit 429 must not strand it.
    router.close();
    const port = (upstream.server.address() as AddressInfo).port;
    router = createRouter({
      config: Config.parse({ upstream: `http://127.0.0.1:${port}` }),
      accounts: () => live,
      reload: () => {},
      state,
      log,
      now: () => (bench?.until ?? 0) + 1,
    });
    routerUrl = `http://127.0.0.1:${await listen(router)}`;
    upstream.queue.push(fromFixture("fable-429-7d_oi-rejected"));
    await messages(session("p2", "claude-fable-5-1"), { "x-claude-router-account": "personal" });
    expect(state.account("personal").bench).toBeNull();
  });

  it("marks a 401 broken until reload clears it", async () => {
    upstream.queue.push((_req, res) =>
      reply(res, 401, {}, '{"error":{"type":"authentication_error"}}'),
    );
    await messages(session("b"), { "x-claude-router-account": "personal" });
    expect(state.account("personal").broken?.reason).toBe("401");
    await messages(session("b2"));
    expect(upstream.seen.at(-1)?.auth).not.toBe("Bearer tok-personal");
  });
});

describe("passthrough", () => {
  it("forwards the desktop app with its own auth and no pin", async () => {
    const res = await messages(session("d"), {
      "user-agent": "claude-cli/2.1.284 (external, claude-desktop, agent-sdk/0.3.276)",
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0]?.auth).toBe("Bearer client-token");
    expect(state.pins).toEqual({});
    expect(log.entries[0]).toMatchObject({ kind: "passthrough", entrypoint: "claude-desktop" });
  });

  it("forwards non-inference paths and fails open with no accounts", async () => {
    await fetch(`${routerUrl}/api/hello`, {
      method: "HEAD",
      headers: { authorization: "Bearer client-token" },
    });
    expect(upstream.seen[0]).toMatchObject({ path: "/api/hello", auth: "Bearer client-token" });
    live = [];
    await messages(session("n"));
    expect(upstream.seen[1]?.auth).toBe("Bearer client-token");
    expect(log.entries[1]).toMatchObject({ kind: "passthrough", reason: "no accounts, fail open" });
  });

  it("sends exactly one credential upstream and never the router header or the client's host", async () => {
    upstream.fallback = (req, res) =>
      reply(
        res,
        200,
        {
          "x-seen-host": req.headers.host ?? "",
          "x-seen-api-key": String(req.headers["x-api-key"] ?? ""),
        },
        "{}",
      );
    const res = await messages(session("h"), {
      "x-claude-router-account": "work",
      "x-api-key": "client-api-key",
    });
    expect(res.headers.get("x-seen-host")).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(res.headers.get("x-seen-host")).not.toBe(new URL(routerUrl).host);
    expect(res.headers.get("x-seen-api-key")).toBe("");
    expect(upstream.seen[0]).toMatchObject({ auth: "Bearer tok-work", forced: undefined });
  });
});
