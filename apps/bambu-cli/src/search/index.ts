import { Command } from "commander";
import { z } from "zod";
import type { Config } from "../config.ts";
import { jsonFlag, next, output, reportError, UsageError } from "../cli.ts";
import { search, SITE_NAMES, SITES, SORTS, type Fetch, type ModelResult } from "./core.ts";
import { fetchModel } from "./download.ts";
import { renderCandidatesPage } from "../view/candidates.ts";
import { publish, slug } from "../view/publish.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
export * from "./core.ts";
export * from "./download.ts";
export const REMOVED_MESSAGE = (source: string) => `\`--source ${source}\` was removed in v2.1.

Model search now asks each site's own search API instead of a web search engine,
which returned ads and pages from other sites. Thingiverse's API needs every user to
register their own OAuth app, and Thangs has no public API, so neither is searched
for now. Search MakerWorld and Printables instead:

  bambu search "<query>"
  bambu search "<query>" --source printables`;

export function formatResult(number: number, candidate: ModelResult): string {
  const stats = [SITE_NAMES[candidate.site]];
  if (candidate.author) stats.push(`by ${candidate.author}`);
  if (candidate.downloads !== null)
    stats.push(`${candidate.downloads.toLocaleString("en-US")} downloads`);
  if (candidate.likes !== null) stats.push(`${candidate.likes.toLocaleString("en-US")} likes`);
  stats.push(candidate.license || "licence not stated");
  return `${String(number).padStart(2)}. ${candidate.title}\n    ${stats.join(" · ")}\n    ${candidate.url}`;
}
export function humanSearch(report: Awaited<ReturnType<typeof search>>): string {
  const names = report.sites.map((s) => SITE_NAMES[s]).join(" and ");
  if (!report.results.length)
    return report.failed_sites.length === report.sites.length
      ? ""
      : `No models found for "${report.query}" on ${names}. Try fewer or different words, or English terms.`;
  return `${report.results.length} models for "${report.query}" on ${names}, by ${report.sort}:\n\n${report.results.map((c, i) => formatResult(i + 1, c)).join("\n")}\n\n${next("Show Connor the Candidates page (or these options) and let him pick a number; `bambu fetch` downloads Printables picks, MakerWorld picks he downloads himself.")}`;
}
// Register Search and anonymous Printables fetching; no credentials are needed.
export function register(
  program: Command,
  _config: Config,
  fetcher: Fetch = globalThis.fetch,
): void {
  program
    .command("search")
    .description("find Models on MakerWorld and Printables")
    .argument("<query>")
    .option("-s, --source <site>", "{all,makerworld,printables}", "all")
    .option(
      "-l, --limit <number>",
      "total number of results across all sites, not per site (1-50)",
      "5",
    )
    .option("--sort <sort>", SORTS.join(", "), "downloads")
    .option("--page [file]", "write a Candidates page (default candidates.html) and publish it")
    .option("--no-publish", "with --page: write the file but do not upload it")
    .option("--json")
    .action(async (query: string, raw: unknown) => {
      const parsed = z
        .object({
          source: z.string(),
          limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50)),
          sort: z.enum(SORTS),
          page: z.union([z.string(), z.boolean()]).optional(),
          publish: z.boolean(),
          json: z.boolean().optional(),
        })
        .safeParse(raw);
      const usage = (message: string) => reportError(jsonFlag(raw), new UsageError(message));
      if (!parsed.success)
        return usage("invalid search arguments (limit must be between 1 and 50)");
      const options = parsed.data;
      if (["thangs", "thingiverse"].includes(options.source))
        return usage(REMOVED_MESSAGE(options.source));
      const source = z.enum(["all", ...SITES]).safeParse(options.source);
      if (!source.success) return usage("source must be all, makerworld or printables");
      if (!query.trim()) return usage("the search query is empty");
      const report = await search(query, {
        sites: source.data === "all" ? [...SITES] : [source.data],
        limit: options.limit,
        sort: options.sort,
        fetcher,
      });
      for (const failure of report.failed_sites)
        console.error(`${SITE_NAMES[failure.site]} could not be searched: ${failure.reason}`);
      if (report.failed_sites.length === report.sites.length) {
        console.error("Search failed on every site; check the internet connection and try again.");
        process.exitCode = 1;
      }
      // The Candidates page is how Connor picks: a numbered gallery, published
      // privately, that he answers with a number.
      let page: { file: string; url?: string } | undefined;
      if (options.page && report.results.length)
        try {
          const file = resolve(typeof options.page === "string" ? options.page : "candidates.html");
          writeFileSync(file, renderCandidatesPage(query, report.results, options.sort));
          page = { file };
          if (options.publish)
            page.url = publish(file, `bambu/candidates/${slug(query, "search")}.html`);
        } catch (error) {
          // The search itself succeeded; the page failure keeps the --json contract.
          const message = `Candidates page failed: ${error instanceof Error ? error.message : String(error)}`;
          if (options.json) output(true, { error: { type: "page_failed", message } }, () => "");
          console.error(`bambu: ${message}`);
          process.exitCode = 1;
          return;
        }
      if (
        options.json ||
        report.results.length ||
        report.failed_sites.length !== report.sites.length
      )
        output(Boolean(options.json), { ...report, page }, () =>
          [humanSearch(report), page && `Candidates page: ${page.url ?? page.file}`]
            .filter(Boolean)
            .join("\n"),
        );
    });
  program
    .command("fetch")
    .description("download a Printables Model into a Print Job folder")
    .argument("<url-or-id>")
    .option("--out <dir>")
    .option("--force", "overwrite existing files")
    .option("--json")
    .action(async (input: string, raw: unknown) => {
      const options = z
        .object({
          out: z.string().optional(),
          force: z.boolean().optional(),
          json: z.boolean().optional(),
        })
        .parse(raw);
      try {
        const report = await fetchModel(input, { ...options, fetcher });
        output(Boolean(options.json), report, () =>
          [
            ...report.files.map((f) => f.path),
            ...report.skipped.map(
              (name) =>
                `Skipped ${name} (only STL, 3MF, OBJ, GLB, and PLY can be analyzed and sliced)`,
            ),
          ].join("\n"),
        );
      } catch (error) {
        reportError(Boolean(options.json), error, "fetch_failed");
      }
    });
}
