import { z } from "zod";

export const SITES = ["makerworld", "printables"] as const;
export type Site = (typeof SITES)[number];
export const SORTS = ["downloads", "likes", "newest", "relevance"] as const;
export type Sort = (typeof SORTS)[number];
export const SITE_NAMES = { makerworld: "MakerWorld", printables: "Printables" };
export const USER_AGENT = "bambu-cli (github.com/connorch/skills)";
export const PRINTABLES_ENDPOINT = "https://api.printables.com/graphql/";
export const MAKERWORLD_ENDPOINT = "https://api.bambulab.com/v1/search-service/select/design2";
export type Fetch = typeof globalThis.fetch;
export class SiteError extends Error {}
export interface ModelResult {
  site: Site;
  id: string;
  title: string;
  url: string;
  author: string;
  license: string;
  likes: number | null;
  downloads: number | null;
  prints: number | null;
  published: string;
  thumbnail: string;
}
export function mapping(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).safeParse(value).data ?? {};
}
export function mappings(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> =>
          v !== null && typeof v === "object" && !Array.isArray(v),
      )
    : [];
}
export function text(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/\p{Cc}/gu, "")
    : "";
}
export function modelId(value: unknown): string {
  const raw =
    typeof value === "string" || (typeof value === "number" && Number.isInteger(value))
      ? String(value)
      : "";
  return /^\d+$/.test(raw) ? raw : "";
}
export function count(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^[+-]?\d+$/.test(value.trim())) return null;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}
export function utcTimestamp(value: unknown): string {
  let raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw)) return "";
  if (raw.includes("T") && !/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) raw += "Z";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function pageUrl(site: Site, id: string, slug: unknown): string {
  const base =
    site === "makerworld"
      ? "https://makerworld.com/en/models/"
      : "https://www.printables.com/model/";
  const cleaned = encodeURIComponent(text(slug)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${base}${id}${cleaned ? `-${cleaned}` : ""}`;
}
export function isSiteUrl(site: Site, raw: string): boolean {
  try {
    const url = new URL(raw);
    const hosts =
      site === "makerworld" ? ["makerworld.com"] : ["printables.com", "www.printables.com"];
    return (
      url.protocol === "https:" &&
      hosts.includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !/^https:\/\/[^/]+:\d+/.test(raw)
    );
  } catch {
    return false;
  }
}
// Decode one API request without paging or retries; fetch is injectable for offline replay.
export async function requestJson(
  url: string,
  payload?: unknown,
  fetcher: Fetch = globalThis.fetch,
  timeout = 10,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      throw new SiteError(`no answer within ${timeout} s`);
    throw new SiteError("could not connect (offline, DNS or TLS problem)");
  }
  if (response.status >= 400 && !(payload !== undefined && response.status === 400))
    throw new SiteError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new SiteError(`HTTP ${response.status}, response was not JSON`);
  }
}
export function graphqlData(document: unknown): Record<string, unknown> {
  const body = mapping(document);
  const errors = mappings(body.errors);
  if (errors.length)
    throw new SiteError(`Printables rejected the query: ${text(errors[0]?.message).slice(0, 200)}`);
  return mapping(body.data);
}
// Parse site Candidates, tolerating malformed individual records.
export function parseResponse(site: Site, document: unknown): ModelResult[] {
  const body = mapping(document);
  if (site === "makerworld" && body.keywordBlock === true)
    throw new SiteError(
      `MakerWorld blocks this search term${text(body.blockedMessage) ? `: ${text(body.blockedMessage)}` : ""}`,
    );
  const found = site === "makerworld" ? body : mapping(graphqlData(document).searchPrints2);
  const key = site === "makerworld" ? "hits" : "items";
  if (!(key in found))
    throw new SiteError(`unexpected response from ${SITE_NAMES[site]} (no search ${key})`);
  return mappings(found[key]).flatMap((item) => {
    const id = modelId(item.id),
      title = text(site === "makerworld" ? item.title : item.name);
    if (!id || !title || item.nsfw === true) return [];
    const creator = mapping(site === "makerworld" ? item.designCreator : item.user);
    const license = mapping(item.license);
    const name =
      site === "makerworld" ? text(item.license) : text(license.abbreviation) || text(license.name);
    const image = text(mapping(item.image).filePath).replace(/^\/+/, "");
    return [
      {
        site,
        id,
        title,
        url: pageUrl(site, id, item.slug),
        author:
          text(site === "makerworld" ? creator.name : creator.publicUsername) ||
          text(creator.handle),
        license: site === "makerworld" && name.startsWith("BY") ? `CC-${name}` : name,
        likes: count(site === "makerworld" ? item.likeCount : item.likesCount),
        downloads: count(item.downloadCount),
        prints: count(site === "makerworld" ? item.printCount : item.makesCount),
        published: utcTimestamp(site === "makerworld" ? item.createTime : item.datePublished),
        thumbnail:
          site === "makerworld"
            ? text(item.cover).startsWith("https://")
              ? text(item.cover)
              : ""
            : image
              ? `https://media.printables.com/${image.split("/").map(encodeURIComponent).join("/")}`
              : "",
      },
    ];
  });
}
export const SEARCH_QUERY = `query SearchModels($query: String!, $limit: Int!, $ordering: SearchChoicesEnum) {
  searchPrints2(query: $query, printType: print, limit: $limit, ordering: $ordering) {
    items { id name slug nsfw likesCount downloadCount makesCount datePublished
      license { name abbreviation } user { publicUsername handle } image { filePath }
    }
  }
}`;
export function mentionsQuery(query: string, candidates: ModelResult[]): boolean {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (w) => [...w].length > 1,
  );
  return (
    !words.length ||
    candidates.some((c) => words.some((w) => `${c.title} ${c.url}`.toLowerCase().includes(w)))
  );
}
export async function searchSite(
  site: Site,
  query: string,
  limit: number,
  sort: Sort,
  fetcher: Fetch = globalThis.fetch,
  timeout = 10,
): Promise<ModelResult[]> {
  const orders = {
    downloads: "downloadCount",
    likes: "likeCount",
    newest: "newUploads",
    relevance: "score",
  };
  const ordering = {
    downloads: "popular",
    likes: "popular",
    newest: "latest",
    relevance: "best_match",
  };
  const document =
    site === "makerworld"
      ? await requestJson(
          `${MAKERWORLD_ENDPOINT}?${new URLSearchParams({ keyword: query, limit: String(limit), offset: "0", orderBy: orders[sort] })}`,
          undefined,
          fetcher,
          timeout,
        )
      : await requestJson(
          PRINTABLES_ENDPOINT,
          {
            operationName: "SearchModels",
            query: SEARCH_QUERY,
            variables: { query, limit, ordering: ordering[sort] },
          },
          fetcher,
          timeout,
        );
  const candidates = parseResponse(site, document).slice(0, limit);
  return site === "printables" && !mentionsQuery(query, candidates) ? [] : candidates;
}
export async function search(
  query: string,
  {
    sites = [...SITES],
    limit = 5,
    sort = "downloads",
    fetcher = globalThis.fetch,
    timeout = 10,
  }: { sites?: Site[]; limit?: number; sort?: Sort; fetcher?: Fetch; timeout?: number } = {},
) {
  query = query.trim().replace(/\s+/gu, " ");
  sites = [...new Set(sites)];
  if (!query) throw new Error("the search query is empty");
  if (!sites.length || sites.some((s) => !SITES.includes(s)))
    throw new Error(`sites must be chosen from ${SITES.join(", ")}`);
  if (!SORTS.includes(sort)) throw new Error(`sort must be one of ${SORTS.join(", ")}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("limit must be between 1 and 50");
  const answers = await Promise.allSettled(
    sites.map((site) => searchSite(site, query, limit, sort, fetcher, timeout)),
  );
  const failed_sites: { site: Site; reason: string }[] = [];
  const groups: ModelResult[][] = [];
  answers.forEach((answer, i) => {
    const site = sites[i]!;
    if (answer.status === "fulfilled")
      groups.push(answer.value.filter((c) => c.site === site && isSiteUrl(site, c.url)));
    else
      failed_sites.push({
        site,
        reason:
          answer.reason instanceof SiteError
            ? answer.reason.message
            : `unexpected error (${answer.reason instanceof Error ? answer.reason.name : "Error"})`,
      });
  });
  let ranked = groups.flat();
  if (sort === "relevance")
    ranked = Array.from({ length: Math.max(0, ...groups.map((g) => g.length)) }, (_, i) =>
      groups.flatMap((g) => (g[i] ? [g[i]] : [])),
    ).flat();
  else
    ranked.sort((a, b) =>
      sort === "newest"
        ? b.published.localeCompare(a.published)
        : (b[sort] ?? -1) - (a[sort] ?? -1) ||
          (b[sort === "downloads" ? "likes" : "downloads"] ?? -1) -
            (a[sort === "downloads" ? "likes" : "downloads"] ?? -1),
    );
  const seen = new Set<string>();
  const results = ranked
    .filter((c) => {
      const key = `${c.site}:${c.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
  return { query, sites, sort, results, failed_sites };
}
