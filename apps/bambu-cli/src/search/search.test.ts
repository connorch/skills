import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { Config } from "../config.ts";
import {
  fetchModel,
  formatResult,
  humanSearch,
  isSiteUrl,
  mentionsQuery,
  parseResponse,
  printablesId,
  register,
  requestJson,
  search,
  searchSite,
  SORTS,
  text,
  utcTimestamp,
  USER_AGENT,
  type Fetch,
} from "./index.ts";
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
function replay(failure?: string): Fetch {
  return vi.fn(async (input) => {
    const makerworld = String(input).includes("bambulab");
    if (failure === "all") throw new TypeError("offline");
    if (failure === "makerworld" && makerworld) return new Response("{}", { status: 503 });
    return Response.json(fixture(makerworld ? "makerworld_phone_stand" : "printables_phone_stand"));
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
describe("recorded site adapters", () => {
  it("maps both recorded first Candidates exactly", () => {
    expect(parseResponse("makerworld", fixture("makerworld_phone_stand"))[0]).toEqual({
      site: "makerworld",
      id: "1087279",
      title: "Small smartphone stand - print in place design",
      url: "https://makerworld.com/en/models/1087279-small-smartphone-stand-print-in-place-design",
      author: "mgm86",
      license: "Standard Digital File License",
      likes: 20203,
      downloads: 78580,
      prints: 65802,
      published: "2025-02-08T18:49:02Z",
      thumbnail:
        "https://makerworld.bblmw.com/makerworld/model/US9ed59c39f449a5/design/03f80702c023e3a0.jpg",
    });
    const first = parseResponse("printables", fixture("printables_phone_stand"))[0];
    expect(first).toMatchObject({
      site: "printables",
      id: "187125",
      title: "Phone Stand",
      author: "PlatinumStars",
      license: "CC-BY-NC",
      likes: 11358,
      downloads: 86047,
      prints: 744,
      published: "2025-06-03T07:38:44Z",
    });
    expect(
      parseResponse("makerworld", fixture("makerworld_phone_stand")).find((c) => c.id === "127277")
        ?.license,
    ).toBe("CC-BY-NC-SA");
  });
  it.each(SORTS)("sends one honest request per site for %s", async (sort) => {
    const fetcher = replay();
    await searchSite("makerworld", "vase", 3, sort, fetcher);
    await searchSite("printables", "phone stand", 4, sort, fetcher, 7);
    const calls = vi.mocked(fetcher).mock.calls;
    expect(calls).toHaveLength(2);
    const url = new URL(String(calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keyword: "vase",
      limit: "3",
      offset: "0",
      orderBy: {
        downloads: "downloadCount",
        likes: "likeCount",
        newest: "newUploads",
        relevance: "score",
      }[sort],
    });
    expect(calls[0]?.[1]?.headers).toMatchObject({ "User-Agent": USER_AGENT });
    expect(calls[1]?.[0]).toBe("https://api.printables.com/graphql/");
    const payload: unknown = JSON.parse(String(calls[1]?.[1]?.body));
    expect(payload).toMatchObject({
      variables: {
        query: "phone stand",
        limit: 4,
        ordering: {
          downloads: "popular",
          likes: "popular",
          newest: "latest",
          relevance: "best_match",
        }[sort],
      },
    });
    expect(String(calls[1]?.[1]?.body)).toContain("$ordering: SearchChoicesEnum");
  });
  it("skips malformed and NSFW Candidates and escapes slugs", () => {
    expect(
      parseResponse("makerworld", {
        hits: [
          null,
          "bad",
          { id: "../1", title: "x" },
          { id: 2, title: "x", nsfw: true },
          { id: 3, title: "Nice", slug: "x/../../@evil.example?#" },
        ],
      }),
    ).toHaveLength(1);
    const c = parseResponse("makerworld", {
      hits: [{ id: 3, title: "Nice", slug: "x/../../@evil.example?#" }],
    })[0]!;
    expect(c.url).toContain("3-x%2F..%2F..%2F%40evil.example");
    expect(isSiteUrl("makerworld", c.url)).toBe(true);
    expect(() =>
      parseResponse("makerworld", { keywordBlock: true, blockedMessage: "Sensitive keyword" }),
    ).toThrow("blocks this search term: Sensitive keyword");
    expect(() => parseResponse("makerworld", {})).toThrow("unexpected response");
    expect(() => parseResponse("printables", fixture("printables_bad_ordering"))).toThrow(
      "rejected the query",
    );
    expect(parseResponse("printables", fixture("printables_empty"))).toEqual([]);
  });
  it("uses full licence names and empty thumbnails when missing", () => {
    const candidates = parseResponse("printables", {
      data: {
        searchPrints2: {
          items: [
            {
              id: "1",
              name: "Model",
              license: { abbreviation: null, name: "Standard Digital File License" },
              image: null,
            },
          ],
        },
      },
    });
    expect(candidates[0]).toMatchObject({
      license: "Standard Digital File License",
      thumbnail: "",
    });
  });
  it("decodes GraphQL errors even with HTTP 400", async () => {
    const fetcher: Fetch = async () =>
      Response.json(fixture("printables_bad_ordering"), { status: 400 });
    await expect(searchSite("printables", "phone stand", 5, "downloads", fetcher)).rejects.toThrow(
      "rejected the query",
    );
  });
  it("does not trust ignored queries, but allows punctuation and single letters", () => {
    const ignored = parseResponse("printables", fixture("printables_query_ignored"));
    expect(mentionsQuery("花瓶", ignored)).toBe(false);
    expect(mentionsQuery("playable ocarina", ignored)).toBe(true);
    for (const query of ["phone-stand", "Phone stand!", "a phone stand (v2)", "x"])
      expect(
        mentionsQuery(query, parseResponse("printables", fixture("printables_phone_stand"))),
      ).toBe(true);
  });
  it.each([503, 429])("reports HTTP %s", async (status) => {
    await expect(
      requestJson("https://example.com", undefined, async () => new Response("{}", { status })),
    ).rejects.toThrow(`HTTP ${status}`);
  });
  it("reports timeout, connection and non-JSON failures", async () => {
    await expect(
      requestJson("https://example.com", undefined, async () => {
        throw new DOMException("slow", "TimeoutError");
      }),
    ).rejects.toThrow("no answer within 10 s");
    await expect(
      requestJson("https://example.com", undefined, async () => {
        throw new TypeError("offline");
      }),
    ).rejects.toThrow("could not connect");
    await expect(
      requestJson("https://example.com", undefined, async () => new Response("html")),
    ).rejects.toThrow("not JSON");
  });
  it.each([
    "http://makerworld.com/en/models/1",
    "https://makerworld.com.evil.example/en/models/1",
    "https://makerworld.com@evil.example/en/models/1",
    "https://makerworld.com:8443/en/models/1",
    "javascript:alert(1)",
  ])("rejects off-site URL %s", (url) => expect(isSiteUrl("makerworld", url)).toBe(false));
  it("cleans terminal text and normalizes UTC", () => {
    expect(text("Nice\x1b[2J  stand\n\t v2")).toBe("Nice[2J stand v2");
    for (const raw of ["2025-06-03T07:38:44.615430+00:00", "2025-06-03T09:38:44+02:00"])
      expect(utcTimestamp(raw)).toBe("2025-06-03T07:38:44Z");
    expect(utcTimestamp("yesterday")).toBe("");
  });
});
describe("Search command", () => {
  async function run(args: string[], fetcher = replay()) {
    const out = vi.spyOn(console, "log").mockImplementation(() => {}),
      err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    register(program, new Config({ env: {} }), fetcher);
    await program.parseAsync(args, { from: "user" });
    return {
      out: out.mock.calls.map((c) => String(c[0])).join("\n"),
      err: err.mock.calls.map((c) => String(c[0])).join("\n"),
      code: process.exitCode ?? 0,
      fetcher,
    };
  }
  it("lists the information needed to choose and limits the total", async () => {
    const report = await search("phone stand", { fetcher: replay() });
    expect(report.results).toHaveLength(5);
    expect(report.results.slice(0, 3).map((c) => c.site)).toEqual([
      "printables",
      "makerworld",
      "makerworld",
    ]);
    expect(formatResult(1, report.results[0]!)).toContain(
      "Printables · by PlatinumStars · 86,047 downloads · 11,358 likes · CC-BY-NC",
    );
    expect(humanSearch(report).trim().split("\n").at(-1)).toMatch(
      /^➡️ Show Connor the Candidates page/,
    );
    const result = await run(["search", "phone stand", "-l", "3", "--json"]);
    expect(JSON.parse(result.out)).toMatchObject({
      query: "phone stand",
      sort: "downloads",
      failed_sites: [],
    });
    expect(result.err).toBe("");
  });
  it.each(["makerworld", "all"])(
    "reports %s failure without hiding the JSON document",
    async (failure) => {
      const result = await run(["search", "phone stand", "--json"], replay(failure));
      const doc: { results: unknown[]; failed_sites: unknown[] } = JSON.parse(result.out);
      expect(doc.failed_sites).toHaveLength(failure === "all" ? 2 : 1);
      expect(result.code).toBe(failure === "all" ? 1 : 0);
      expect(result.err).toContain("could not be searched");
    },
  );
  it.each([
    ["--source", "thangs"],
    ["--source", "thingiverse"],
    ["--source", "cults3d"],
    ["--limit", "0"],
    ["--limit", "51"],
    ["--sort", "rating"],
  ])("rejects invalid flags %s %s", async (flag, value) => {
    const result = await run(["search", "vase", flag, value]);
    expect(result.code).toBe(2);
    expect(result.fetcher).not.toHaveBeenCalled();
    if (["thangs", "thingiverse"].includes(value)) expect(result.err).toContain("OAuth");
  });
  it("routes source and newest ordering to only MakerWorld", async () => {
    const result = await run(["search", "vase", "-s", "makerworld", "--sort", "newest", "--json"]);
    expect(JSON.parse(result.out)).toMatchObject({ sites: ["makerworld"] });
    expect(vi.mocked(result.fetcher).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(result.fetcher).mock.calls[0]?.[0])).toContain("orderBy=newUploads");
  });
  it("all failed human search emits no false no-results message", async () => {
    const result = await run(["search", "phone stand"], replay("all"));
    expect(result.out).toBe("");
    expect(result.err).toContain("failed on every site");
    expect(result.code).toBe(1);
  });
  it("rejects blank query and explains help", async () => {
    const result = await run(["search", "   ", "--json"]);
    expect(JSON.parse(result.out)).toEqual({
      error: { type: "usage", message: "the search query is empty" },
    });
    expect(result.code).toBe(2);
    const p = new Command();
    register(p, new Config());
    const help = p.commands[0]!.helpInformation();
    expect(help).toContain("total number of results across all sites, not per site");
    expect(help).not.toContain("thangs");
  });
  it("alternates relevance and preserves empty successful searches", async () => {
    const report = await search("phone stand", { sort: "relevance", fetcher: replay() });
    expect(report.results.map((c) => c.site)).toEqual([
      "makerworld",
      "printables",
      "makerworld",
      "printables",
      "makerworld",
    ]);
    const empty = await search("nothing", {
      sites: ["printables"],
      fetcher: async () => Response.json(fixture("printables_empty")),
    });
    expect(empty.results).toEqual([]);
    expect(humanSearch(empty)).toContain("No models found");
  });
});
describe("MakerWorld download links", () => {
  const zip = zipSync({
    "clip/clip-120mm.stl": strToU8("solid mesh"),
    "clip/readme.txt": strToU8("hi"),
  });
  const texturedZip = zipSync({
    "model.obj": strToU8("mtllib materials/model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    "materials/model.mtl": strToU8("newmtl m\nmap_Kd ../textures/c.png\n"),
    "textures/c.png": strToU8("png"),
  });
  const caseZip = zipSync({
    "Model.stl": strToU8("solid a"),
    "model.stl": strToU8("solid b"),
  });
  // The same name in two Unicode forms, which APFS treats as one file.
  const formsZip = zipSync({
    "caf\u00e9.stl": strToU8("solid a"),
    "cafe\u0301.stl": strToU8("solid b"),
  });
  const nestedZip = zipSync({
    "model.obj": strToU8("v 0 0 0\n"),
    "textures/new/c.png": strToU8("png"),
  });
  const ancestryZip = zipSync({
    "part.obj": strToU8("v 0 0 0\n"),
    "part.obj/textures/c.png": strToU8("png"),
  });
  const escapingZip = zipSync({
    "model.obj": strToU8("v 0 0 0\n"),
    "../victim.png": strToU8("png"),
  });
  const fetcher: Fetch = vi.fn(async (input) =>
    String(input).endsWith(".zip?at=1&key=2")
      ? new Response(zip)
      : String(input).endsWith("textured.zip")
        ? new Response(texturedZip)
        : String(input).endsWith("escaping.zip")
          ? new Response(escapingZip)
          : String(input).endsWith("case.zip")
            ? new Response(caseZip)
            : String(input).endsWith("forms.zip")
              ? new Response(formsZip)
              : String(input).endsWith("nested.zip")
                ? new Response(nestedZip)
                : String(input).endsWith("ancestry.zip")
                  ? new Response(ancestryZip)
                  : String(input).includes("expired")
                    ? new Response("<html>expired</html>")
                    : new Response("solid mesh"),
  );
  it("unpacks the Model files from a signed zip and credits the page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    const report = await fetchModel("https://makerworld.bblmw.com/model/stls.zip?at=1&key=2", {
      out: dir,
      page: "https://makerworld.com/en/models/42-clip",
      fetcher,
    });
    expect(report.files.map((f) => f.name)).toEqual(["clip-120mm.stl"]);
    expect(report.skipped).toEqual(["clip/readme.txt"]);
    expect(await readFile(join(dir, "clip-120mm.stl"), "utf8")).toBe("solid mesh");
    expect(JSON.parse(await readFile(join(dir, "source.json"), "utf8"))).toEqual({
      route: "Search",
      site: "MakerWorld",
      title: "stls",
      url: "https://makerworld.com/en/models/42-clip",
    });
  });
  it("keeps an OBJ's companion folders so its MTL and texture references resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    const report = await fetchModel("https://makerworld.bblmw.com/m/textured.zip", {
      out: dir,
      fetcher,
    });
    expect(report.files.map((f) => f.name).sort()).toEqual([
      "materials/model.mtl",
      "model.obj",
      "textures/c.png",
    ]);
    expect(existsSync(join(dir, "materials", "model.mtl"))).toBe(true);
  });
  it("refuses a zip whose member path climbs out of the job folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/escaping.zip", { out: dir, fetcher }),
    ).rejects.toThrow("unsafe filename");
    expect(existsSync(join(dir, "..", "victim.png"))).toBe(false);
    expect(existsSync(join(dir, "model.obj"))).toBe(false);
  });
  it("refuses to write through a folder linked out of the job folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-")),
      elsewhere = await mkdtemp(join(tmpdir(), "bambu-elsewhere-"));
    await symlink(elsewhere, join(dir, "textures"));
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/textured.zip", { out: dir, fetcher }),
    ).rejects.toThrow("leave the job folder");
    expect(await readdir(elsewhere)).toEqual([]);
    // Nor made a folder through the link before refusing.
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/nested.zip", { out: dir, fetcher }),
    ).rejects.toThrow("leave the job folder");
    expect(await readdir(elsewhere)).toEqual([]);
  });
  it("refuses a member that is also another member's folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/ancestry.zip", { out: dir, fetcher }),
    ).rejects.toThrow("both a file and a folder");
    expect(await readdir(dir)).toEqual([]);
  });
  it("leaves a .tmp another fetch is writing alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    await writeFile(join(dir, "clip.stl.tmp"), "theirs");
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/clip.stl?key=3", { out: dir, fetcher }),
    ).rejects.toThrow("another fetch");
    expect(await readFile(join(dir, "clip.stl.tmp"), "utf8")).toBe("theirs");
  });
  it("refuses members whose names differ only in case", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/case.zip", { out: dir, fetcher }),
    ).rejects.toThrow("twice");
    expect(existsSync(join(dir, "model.stl"))).toBe(false);
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/forms.zip", { out: dir, fetcher }),
    ).rejects.toThrow("twice");
  });
  it("saves a single file under its own name and refuses an expired link's page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    const report = await fetchModel("https://makerworld.bblmw.com/m/clip.stl?key=3", {
      out: dir,
      fetcher,
    });
    expect(report.files.map((f) => f.name)).toEqual(["clip.stl"]);
    await expect(
      fetchModel("https://makerworld.bblmw.com/m/expired.stl", { out: dir, force: true, fetcher }),
    ).rejects.toThrow("HTML");
    await expect(
      fetchModel("https://makerworld.com/en/models/42-clip", { out: dir, fetcher }),
    ).rejects.toThrow("Download button");
  });
});
describe("Printables fetching", () => {
  it("downloads supported files, skips others, and protects existing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    const fetcher: Fetch = vi.fn(async (input, init) => {
      if (String(input).includes("files.example")) return new Response("solid mesh");
      const body = String(init?.body);
      return Response.json(
        body.includes("getDownloadLink")
          ? {
              data: {
                getDownloadLink: { ok: true, output: { link: "https://files.example/model" } },
              },
            }
          : {
              data: {
                print: {
                  id: "42",
                  name: "Model",
                  slug: "model",
                  user: { publicUsername: "FH" },
                  license: { abbreviation: "CC-BY-SA" },
                  stls: [
                    { id: "1", name: "model.stl", fileSize: 10 },
                    { id: "2", name: "model.f3d" },
                    { id: "3", name: "model.step" },
                  ],
                },
              },
            },
      );
    });
    try {
      const report = await fetchModel("https://www.printables.com/model/42-model", {
        out: dir,
        fetcher,
      });
      expect(report.files.map((f) => f.bytes)).toEqual([10]);
      expect(report.skipped).toEqual(["model.f3d", "model.step"]);
      expect(await readFile(join(dir, "model.stl"), "utf8")).toBe("solid mesh");
      expect(JSON.parse(await readFile(join(dir, "source.json"), "utf8"))).toEqual({
        route: "Search",
        site: "Printables",
        title: "Model",
        author: "FH",
        url: "https://www.printables.com/model/42-model",
        license: "CC-BY-SA",
      });
      await writeFile(join(dir, "model.stl"), "original");
      await expect(fetchModel("42", { out: dir, fetcher })).rejects.toThrow("EEXIST");
      expect(await readFile(join(dir, "model.stl"), "utf8")).toBe("original");
      await fetchModel("42", { out: dir, force: true, fetcher });
      expect(await readFile(join(dir, "model.stl"), "utf8")).toBe("solid mesh");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("removes what a failed fetch wrote so a plain retry works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    let served = 0;
    const fetcher: Fetch = async (input, init) => {
      if (String(input).includes("files.example"))
        return served++ < 0
          ? new Response("<html>login</html>")
          : served > 1
            ? new Response("nope", { status: 500 })
            : new Response("solid mesh");
      return Response.json(
        String(init?.body).includes("getDownloadLink")
          ? { data: { getDownloadLink: { ok: true, output: { link: "https://files.example/m" } } } }
          : {
              data: {
                print: {
                  id: "42",
                  name: "Model",
                  slug: "model",
                  stls: [
                    { id: "1", name: "a.stl" },
                    { id: "2", name: "b.stl" },
                  ],
                },
              },
            },
      );
    };
    try {
      await expect(fetchModel("42", { out: dir, fetcher })).rejects.toThrow("HTTP 500");
      expect(existsSync(join(dir, "a.stl"))).toBe(false);
      expect(existsSync(join(dir, "a.stl.tmp"))).toBe(false);
      expect(existsSync(join(dir, "source.json"))).toBe(false);
      // --force keeps the old job when the replacement does not complete.
      await writeFile(join(dir, "a.stl"), "solid old");
      served = 0;
      await expect(fetchModel("42", { out: dir, force: true, fetcher })).rejects.toThrow(
        "HTTP 500",
      );
      expect(await readFile(join(dir, "a.stl"), "utf8")).toBe("solid old");
      // A 200 that is not a Model is refused rather than saved under its name.
      served = -1;
      await expect(fetchModel("42", { out: dir, force: true, fetcher })).rejects.toThrow(
        "HTML/JSON",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses an entry with nothing it can download before writing provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bambu-search-"));
    const fetcher: Fetch = async () =>
      Response.json({
        data: {
          print: { id: "42", name: "Model", slug: "model", stls: [{ id: "3", name: "a.step" }] },
        },
      });
    try {
      await expect(fetchModel("42", { out: dir, fetcher })).rejects.toThrow("skipped a.step");
      expect(existsSync(join(dir, "source.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects MakerWorld and untrusted URLs", () => {
    expect(() => printablesId("https://makerworld.com/en/models/1")).toThrow("need a login");
    expect(() => printablesId("https://printables.com.evil.example/model/1")).toThrow("Expected");
    expect(printablesId("42")).toBe("42");
  });
});
