import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  FollowUpLedger,
  Generator,
  HttpClient,
  InputError,
  ProviderError,
  TaskRef,
  createProvider,
  generationResult,
  isUrl,
  loadImage,
  object,
  parseMeshyTask,
  parseRodinFiles,
  parseRodinStatus,
  parseTripoTask,
  sniffProblem,
  standUpright,
  status,
  waitForTask,
  type GenerationRequest,
} from "./index.ts";

const fixtureSchema = z.object({ status: z.number(), body: z.unknown() });
function fixture(name: string) {
  return fixtureSchema.parse(
    JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")),
  );
}
const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "bambu-generate-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function glb() {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: "body" }],
      textures: [{}],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    }),
  );
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const data = Buffer.alloc(20 + padded.length);
  data.write("glTF");
  data.writeUInt32LE(2, 4);
  data.writeUInt32LE(data.length, 8);
  data.writeUInt32LE(padded.length, 12);
  data.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(data, 20);
  return data;
}
function fake() {
  const routes = new Map<string, (string | Response | Error)[]>();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const queue = routes.get(key);
    if (!queue?.length) throw new Error(`unexpected request ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply.clone();
    const recorded = fixture(reply);
    return new Response(JSON.stringify(recorded.body), { status: recorded.status });
  };
  return {
    calls,
    http: new HttpClient(fetcher, async () => {}),
    on(method: string, url: string, ...replies: (string | Response | Error)[]) {
      routes.set(`${method} ${url}`, replies);
      return this;
    },
  };
}
function clock() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (seconds: number) => {
      slept.push(seconds);
      now += seconds;
    },
    slept,
  };
}
const request: GenerationRequest = {
  prompt: "a fireplace mantel",
  output_format: "glb",
  texture: true,
};
const mesh = "https://api.meshy.ai/openapi";
const tripo = "https://openapi.tripo3d.ai/v3";
const rodin = "https://api.hyper3d.com/api/v2";
function id(name: string, field: string) {
  const body = object(fixture(name).body);
  return String(body[field]);
}
const preview = id("meshy/create_preview", "result");
const refine = id("meshy/create_refine", "result");
const trip = String(object(object(fixture("tripo/create_task").body).data).task_id);

describe("recorded task states", () => {
  it.each([
    ["preview_pending", "queued", 0],
    ["preview_in_progress", "running", 55],
    ["preview_succeeded", "succeeded", 100],
    ["task_failed", "failed", 0],
    ["task_canceled", "cancelled", 0],
  ])("Meshy %s", (name, state, progress) => {
    expect(parseMeshyTask(fixture(`meshy/${name}`).body)).toMatchObject({ state, progress });
  });
  it.each([
    ["queued", "queued"],
    ["running", "running"],
    ["success", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["banned", "rejected"],
    ["expired", "expired"],
    ["unknown", "failed"],
  ])("Tripo %s", (name, state) => {
    const result = parseTripoTask(object(fixture(`tripo/task_${name}`).body).data);
    expect(result.state).toBe(state);
    if (!["queued", "running", "succeeded"].includes(state)) expect(result.message).toBeTruthy();
  });
  it.each([
    ["waiting", "queued", 0],
    ["generating", "running", 50],
    ["done", "succeeded", 100],
    ["failed", "failed", null],
    ["no_such_task", "expired", null],
  ])("Rodin %s", (name, state, progress) => {
    expect(parseRodinStatus(fixture(`rodin/status_${name}`).body)).toMatchObject({
      state,
      progress,
    });
  });
  it("preserves failure reasons and unknown states", () => {
    expect(parseTripoTask(object(fixture("tripo/task_failed").body).data).message).toBe(
      "Model too complex (error 2018)",
    );
    expect(parseMeshyTask(fixture("meshy/task_failed").body).message).toContain("too complex");
    expect(parseMeshyTask({ status: "PAUSED" })).toMatchObject({
      state: "running",
      message: "unrecognised Meshy status 'PAUSED'",
    });
    expect(parseRodinStatus(fixture("rodin/status_waiting").body).message).toBe(
      "3 jobs ahead in the queue",
    );
  });
  it("skips Rodin textures and previews", () => {
    expect(parseRodinFiles(fixture("rodin/download").body)).toEqual({
      glb: "https://file.hyper3d.ai/abc/base_basic_pbr.glb?sig=1",
    });
  });
});

describe("provider requests and downloads", () => {
  it("Meshy preview/refine downloads original bytes and records the paid step", async () => {
    const f = fake()
      .on("POST", `${mesh}/v2/text-to-3d`, "meshy/create_preview", "meshy/create_refine")
      .on(
        "GET",
        `${mesh}/v2/text-to-3d/${preview}`,
        "meshy/preview_pending",
        "meshy/preview_in_progress",
        "meshy/preview_succeeded",
      )
      .on("GET", `${mesh}/v2/text-to-3d/${refine}`, "meshy/refine_succeeded");
    const url = parseMeshyTask(fixture("meshy/refine_succeeded").body).outputs.glb!;
    f.on("GET", url.split("?")[0]!, new Response(glb()));
    const provider = createProvider("meshy", "secret", f.http);
    const dir = directory();
    const ledger = new FollowUpLedger(join(dir, "ledger.json"));
    const time = clock();
    const gen = new Generator(provider, dir, ledger, time.sleep, time.now);
    const ref = await provider.create(request);
    const result = await gen.complete(ref);
    expect(ref.token).toBe(`meshy:text:${preview}`);
    expect(result).toMatchObject({
      task_id: `meshy:refine:${refine}`,
      status: "succeeded",
      has_texture: true,
    });
    // The saved GLB is the provider's, stood upright: one extra root node.
    const saved = readFileSync(result.output_file!);
    expect(standUpright(saved)).toEqual(saved);
    expect(JSON.parse(saved.toString("utf8", 20, 20 + saved.readUInt32LE(12))).nodes).toEqual([
      { name: "body" },
      { name: "bambu-upright", rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [0] },
    ]);
    const posts = f.calls.filter((c) => c.init.method === "POST");
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({
      mode: "preview",
      prompt: request.prompt,
      ai_model: "latest",
    });
    expect(JSON.parse(String(posts[1]!.init.body))).toEqual({
      mode: "refine",
      preview_task_id: preview,
    });
    expect(new FollowUpLedger(join(dir, "ledger.json")).get(`${ref.token}>refine`)).toBe(
      `meshy:refine:${refine}`,
    );
    await new Generator(
      provider,
      dir,
      new FollowUpLedger(join(dir, "ledger.json")),
      time.sleep,
      time.now,
    ).complete(ref);
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(2);
    expect(f.calls.find((c) => c.url === url)?.init.headers).toBeUndefined();
  });
  it("Meshy status never pays, no-texture and 3MF requests are explicit", async () => {
    const f = fake()
      .on("GET", `${mesh}/v2/text-to-3d/${preview}`, "meshy/preview_succeeded")
      .on("POST", `${mesh}/v2/text-to-3d`, "meshy/create_preview");
    const provider = createProvider("meshy", "k", f.http);
    expect(
      (
        await new Generator(provider, directory(), new FollowUpLedger()).status(
          new TaskRef("meshy", "text", [preview]),
        )
      ).message,
    ).toContain("`download` starts the Meshy texture step");
    expect(f.calls).toHaveLength(1);
    expect((await provider.create({ ...request, texture: false, output_format: "3mf" })).kind).toBe(
      "preview",
    );
    expect(JSON.parse(String(f.calls.at(-1)!.init.body)).target_formats).toEqual(["glb", "3mf"]);
  });
  it.each(["meshy", "tripo"])("%s sends image URL without prompt", async (name) => {
    const route =
      name === "meshy" ? `${mesh}/v1/image-to-3d` : `${tripo}/generation/image-to-model`;
    const f = fake().on(
      "POST",
      route,
      name === "meshy" ? "meshy/create_image" : "tripo/create_task",
    );
    await createProvider(name, "k", f.http).create({
      ...request,
      image: loadImage("https://example.com/cat.jpg"),
    });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.prompt).toBeUndefined();
    expect(body[name === "meshy" ? "image_url" : "input"]).toBe("https://example.com/cat.jpg");
  });
  it("Meshy inline PNG and Tripo multipart upload use actual bytes", async () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const image = { name: "cat.wrong", data, mime: "image/png" };
    const m = fake().on("POST", `${mesh}/v1/image-to-3d`, "meshy/create_image");
    await createProvider("meshy", "k", m.http).create({ ...request, image });
    expect(JSON.parse(String(m.calls[0]!.init.body)).image_url).toBe(
      `data:image/png;base64,${data.toString("base64")}`,
    );
    const f = fake()
      .on("POST", `${tripo}/files`, "tripo/upload")
      .on("POST", `${tripo}/generation/image-to-model`, "tripo/create_task");
    await createProvider("tripo", "k", f.http).create({ ...request, image });
    const form = f.calls[0]!.init.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("expected form");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("expected file");
    expect(file.name).toBe("cat.png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({
      input: "file_01J8ZKQ4UPLOAD",
      model: "v3.1-20260211",
    });
  });
  it.each(["meshy", "tripo"])("%s rejects local WebP before a request", async (name) => {
    const f = fake();
    await expect(
      createProvider(name, "k", f.http).create({
        ...request,
        image: { name: "cat.webp", data: Buffer.from("RIFFxxxxWEBP"), mime: "image/webp" },
      }),
    ).rejects.toThrow(InputError);
    expect(f.calls).toHaveLength(0);
  });
  it("Tripo V3 disables both texture and PBR", async () => {
    const f = fake().on("POST", `${tripo}/generation/text-to-model`, "tripo/create_task");
    await createProvider("tripo", "k", f.http).create({
      ...request,
      texture: false,
      model: "custom",
    });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      prompt: request.prompt,
      model: "custom",
      texture: false,
      pbr: false,
    });
  });
  it.each(["stl", "3mf"] as const)("Tripo converts %s once and resumes", async (format) => {
    const converted = String(object(object(fixture("tripo/create_convert").body).data).task_id);
    const f = fake()
      .on("GET", `${tripo}/tasks/${trip}`, "tripo/task_success")
      .on("POST", `${tripo}/models/convert`, "tripo/create_convert")
      .on(
        "GET",
        `${tripo}/tasks/${converted}`,
        new Response(
          JSON.stringify({
            code: 0,
            data: { status: "success", output: { model_url: "https://cdn.example/model" } },
          }),
        ),
      )
      .on(
        "GET",
        "https://cdn.example/model",
        new Response(format === "stl" ? "solid model\nendsolid model" : "PKmodel"),
      );
    const dir = directory();
    const time = clock();
    const gen = new Generator(
      createProvider("tripo", "k", f.http),
      dir,
      new FollowUpLedger(join(dir, "ledger")),
      time.sleep,
      time.now,
    );
    const ref = new TaskRef("tripo", "task", [trip]);
    const result = await gen.complete(ref, format, false);
    expect(result.format).toBe(format);
    expect(result.task_id).toBe(`tripo:convert:${converted}:${format}`);
    await gen.complete(ref, format, false);
    const posts = f.calls.filter((c) => c.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({
      input: trip,
      format: format.toUpperCase(),
    });
  });
  it("Meshy missing 3MF starts server conversion once", async () => {
    const converted = id("meshy/create_convert", "result");
    const f = fake()
      .on("GET", `${mesh}/v2/text-to-3d/${preview}`, "meshy/preview_succeeded")
      .on("POST", `${mesh}/v1/convert`, "meshy/create_convert")
      .on("GET", `${mesh}/v1/convert/${converted}`, "meshy/convert_succeeded");
    const url = parseMeshyTask(fixture("meshy/convert_succeeded").body).outputs["3mf"]!;
    f.on("GET", url.split("?")[0]!, new Response("PKmodel"));
    const time = clock();
    const gen = new Generator(
      createProvider("meshy", "k", f.http),
      directory(),
      new FollowUpLedger(),
      time.sleep,
      time.now,
    );
    const ref = new TaskRef("meshy", "preview", [preview]);
    expect((await gen.complete(ref, "3mf", false)).format).toBe("3mf");
    await gen.complete(ref, "3mf", false);
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });
  it("Rodin multipart tier, prompt, status and download use both ids", async () => {
    const f = fake()
      .on("POST", `${rodin}/rodin`, "rodin/submit")
      .on(
        "POST",
        `${rodin}/status`,
        "rodin/status_waiting",
        "rodin/status_generating",
        "rodin/status_done",
      )
      .on("POST", `${rodin}/download`, "rodin/download")
      .on("GET", "https://file.hyper3d.ai/abc/base_basic_pbr.glb", new Response(glb()));
    const provider = createProvider("rodin", "k", f.http);
    const ref = await provider.create(request);
    const time = clock();
    const result = await new Generator(
      provider,
      directory(),
      new FollowUpLedger(),
      time.sleep,
      time.now,
    ).complete(TaskRef.parse(ref.token));
    expect(result.status).toBe("succeeded");
    const form = f.calls[0]!.init.body;
    if (!(form instanceof FormData)) throw new Error("expected multipart");
    expect(Object.fromEntries(form)).toEqual({
      prompt: request.prompt,
      tier: "Gen-2.5-Medium",
      geometry_file_format: "glb",
      material: "PBR",
    });
    expect(JSON.parse(String(f.calls.find((c) => c.url.endsWith("/status"))!.init.body))).toEqual({
      subscription_key: ref.ids[1],
    });
    expect(JSON.parse(String(f.calls.find((c) => c.url.endsWith("/download"))!.init.body))).toEqual(
      { task_uuid: ref.primary_id },
    );
  });
  it("Rodin URL images are fetched unauthenticated and uploaded with guidance", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const f = fake()
      .on("GET", "https://example.com/photo", new Response(png))
      .on("POST", `${rodin}/rodin`, "rodin/submit");
    await createProvider("rodin", "k", f.http, "Gen-2.5-High").create({
      ...request,
      image: loadImage("https://example.com/photo"),
      output_format: "stl",
      texture: false,
    });
    expect(f.calls[0]!.init.headers).toBeUndefined();
    const form = f.calls[1]!.init.body;
    if (!(form instanceof FormData)) throw new Error("expected form");
    expect(form.get("prompt")).toBe(request.prompt);
    expect(form.get("tier")).toBe("Gen-2.5-High");
    expect(form.get("geometry_file_format")).toBe("stl");
    expect(form.get("material")).toBe("None");
    const file = form.get("images");
    if (!(file instanceof File)) throw new Error("expected file");
    expect(file.name).toBe("photo.png");
  });
  it("Tripo expired links refresh and OBJ falls back to GLB", async () => {
    const f = fake().on("GET", `${tripo}/tasks/${trip}`, "tripo/task_success");
    const url = parseTripoTask(object(fixture("tripo/task_success").body).data).outputs.glb!;
    f.on("GET", url.split("?")[0]!, new Response("expired", { status: 403 }), new Response(glb()));
    const time = clock();
    const result = await new Generator(
      createProvider("tripo", "k", f.http),
      directory(),
      new FollowUpLedger(),
      time.sleep,
      time.now,
    ).complete(new TaskRef("tripo", "task", [trip]), "obj", false);
    expect(result.format).toBe("glb");
    expect(result.warnings[0]).toContain("not OBJ");
    expect(f.calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(3);
  });
});

describe("errors and resuming", () => {
  it.each([
    ["meshy", `${mesh}/v2/text-to-3d`, "meshy/error_402", "http_402"],
    ["tripo", `${tripo}/generation/text-to-model`, "tripo/error_2010", "2010"],
    ["rodin", `${rodin}/rodin`, "rodin/submit_insufficient_funds", "API_INSUFFICIENT_FUNDS"],
  ])("%s maps errors without retrying paid POST", async (name, url, recorded, code) => {
    const f = fake().on("POST", url, recorded);
    await expect(createProvider(name, "k", f.http).create(request)).rejects.toMatchObject({ code });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["meshy", "tripo", "rodin"])("%s maps rejected keys", async (name) => {
    const route =
      name === "meshy"
        ? `${mesh}/v2/text-to-3d`
        : name === "tripo"
          ? `${tripo}/generation/text-to-model`
          : `${rodin}/rodin`;
    const f = fake().on("POST", route, `${name}/error_401`);
    await expect(createProvider(name, "k", f.http).create(request)).rejects.toMatchObject({
      http_status: 401,
      retryable: false,
    });
    expect(f.calls).toHaveLength(1);
  });
  it("Tripo HTTP 200 error envelope is rejected", async () => {
    const f = fake().on(
      "POST",
      `${tripo}/generation/text-to-model`,
      new Response(JSON.stringify({ code: 2002, message: "Unsupported parameter" })),
    );
    await expect(createProvider("tripo", "k", f.http).create(request)).rejects.toThrow(
      "Unsupported parameter",
    );
  });
  it("network POST is never retried; GET backs off", async () => {
    const f = fake()
      .on("POST", "https://example.com", new Error("offline"))
      .on("GET", "https://example.com", new Response("busy", { status: 503 }), new Response("{}"));
    await expect(f.http.json("https://example.com", { method: "POST" })).rejects.toMatchObject({
      code: "network",
    });
    expect(f.calls).toHaveLength(1);
    expect(await f.http.json("https://example.com")).toEqual({});
    expect(f.calls).toHaveLength(3);
  });
  it("timeout backs off without resubmission", async () => {
    const time = clock();
    const outcome = await waitForTask(async () => status("running"), {
      timeout_s: 100,
      interval_s: 5,
      max_interval_s: 12,
      sleep: time.sleep,
      clock: time.now,
    });
    expect(outcome.timed_out).toBe(true);
    expect(time.now()).toBe(100);
    expect(time.slept.slice(0, 4)).toEqual([5, 7.5, 11.25, 12]);
  });
  it("poll tolerates temporary errors and raises permanent errors", async () => {
    const time = clock();
    let polls = 0;
    expect(
      (
        await waitForTask(
          async () => {
            if (!polls++) throw new ProviderError("503", "busy", true);
            return status("succeeded");
          },
          { timeout_s: 60, interval_s: 5, max_interval_s: 5, sleep: time.sleep, clock: time.now },
        )
      ).timed_out,
    ).toBe(false);
    await expect(
      waitForTask(
        async () => {
          throw new ProviderError("401", "bad key");
        },
        { timeout_s: 60, interval_s: 5, max_interval_s: 5, sleep: time.sleep, clock: time.now },
      ),
    ).rejects.toThrow("bad key");
  });
  it.each(["failed", "cancelled", "expired", "rejected"] as const)(
    "terminal %s stops polling",
    async (state) => {
      const time = clock();
      expect(
        (
          await waitForTask(async () => status(state), {
            timeout_s: 60,
            interval_s: 5,
            max_interval_s: 5,
            sleep: time.sleep,
            clock: time.now,
          })
        ).status.state,
      ).toBe(state);
      expect(time.slept).toEqual([]);
    },
  );
  it("ledger persists, handles corruption, and keeps most recent step", () => {
    const path = join(directory(), "ledger");
    const ledger = new FollowUpLedger(path);
    ledger.record("meshy:text:abc>refine", "meshy:refine:def");
    expect(new FollowUpLedger(path).startedFrom("meshy:text:abc")).toBe("meshy:refine:def");
    writeFileSync(path, "{not json");
    expect(new FollowUpLedger(path).get("x")).toBeUndefined();
  });
  it.each(["meshy:text:abc", "tripo:convert:task:stl", "rodin:task:uuid:key"])(
    "round trips %s",
    (token) => {
      expect(TaskRef.parse(token).token).toBe(token);
    },
  );
  it("round trips unusual ids", () => {
    const ref = new TaskRef("rodin", "task", ["uuid", "key/with+odd:chars=="]);
    expect(TaskRef.parse(ref.token)).toEqual(ref);
  });
  it.each(["bogus", "meshy:text", "../x:y:z", "meshy:text:a/b"])("rejects %s", (token) => {
    expect(() => TaskRef.parse(token)).toThrow(InputError);
  });
  it("validates local image signatures and paths", () => {
    const dir = directory();
    writeFileSync(join(dir, "cat.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(loadImage(join(dir, "cat.png")).mime).toBe("image/png");
    writeFileSync(join(dir, "notes.txt"), "hello");
    expect(() => loadImage(join(dir, "notes.txt"))).toThrow("not a PNG");
    expect(() => loadImage(join(dir, "missing"))).toThrow("not found");
    expect(isUrl("httpd_logo.png")).toBe(false);
    expect(isUrl("file:///etc/passwd")).toBe(false);
  });
  it("rejects HTML and empty downloads", () => {
    expect(sniffProblem(Buffer.from("<html>"), "glb")).toContain("HTML");
    expect(sniffProblem(Buffer.alloc(0), "glb")).toBe("the download is empty");
  });
  it("submitted result contains resume token", () => {
    expect(generationResult(new TaskRef("meshy", "text", ["abc"]), "submitted").next_command).toBe(
      "bambu generate download meshy:text:abc",
    );
  });
});

describe("resume safety", () => {
  it("timeout keeps the task without another generation", async () => {
    const f = fake()
      .on("POST", `${tripo}/generation/text-to-model`, "tripo/create_task")
      .on("GET", `${tripo}/tasks/${trip}`, "tripo/task_running");
    const provider = createProvider("tripo", "k", f.http);
    const time = clock();
    const ref = await provider.create(request);
    const result = await new Generator(
      provider,
      directory(),
      new FollowUpLedger(),
      time.sleep,
      time.now,
    ).complete(ref, "glb", true, 120, 5);
    expect(result.status).toBe("running");
    expect(result.output_file).toBeNull();
    expect(time.now()).toBe(120);
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });
  it("status follows a recorded refine without posting", async () => {
    const f = fake().on("GET", `${mesh}/v2/text-to-3d/${refine}`, "meshy/refine_succeeded");
    const ledger = new FollowUpLedger();
    ledger.record(`meshy:text:${preview}>refine`, `meshy:refine:${refine}`);
    expect(
      (
        await new Generator(createProvider("meshy", "k", f.http), directory(), ledger).status(
          new TaskRef("meshy", "text", [preview]),
        )
      ).task_id,
    ).toBe(`meshy:refine:${refine}`);
    expect(f.calls).toHaveLength(1);
  });
  it("Rodin 3MF falls back to GLB and malformed tokens fail", async () => {
    const f = fake().on("POST", `${rodin}/rodin`, "rodin/submit");
    const provider = createProvider("rodin", "k", f.http);
    await provider.create({ ...request, output_format: "3mf", texture: false });
    const form = f.calls[0]!.init.body;
    if (!(form instanceof FormData)) throw new Error("expected multipart");
    expect(form.get("geometry_file_format")).toBe("glb");
    await expect(provider.poll(new TaskRef("rodin", "task", ["uuid"]))).rejects.toThrow(
      "rodin:task:<uuid>:<subscription key>",
    );
  });
  it("HTML download leaves no Model or temporary file", async () => {
    const f = fake().on("GET", `${tripo}/tasks/${trip}`, "tripo/task_success");
    const url = parseTripoTask(object(fixture("tripo/task_success").body).data).outputs.glb!;
    f.on("GET", url.split("?")[0]!, new Response("<html>error"));
    const dir = directory();
    await expect(
      createProvider("tripo", "k", f.http).download(
        new TaskRef("tripo", "task", [trip]),
        "glb",
        dir,
      ),
    ).rejects.toMatchObject({ code: "not_a_model" });
    expect(() => readFileSync(join(dir, `tripo_${trip}.glb`))).toThrow();
    expect(() => readFileSync(join(dir, `tripo_${trip}.glb.tmp`))).toThrow();
  });
});
