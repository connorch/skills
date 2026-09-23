import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomic, exists, json, type State } from "./files.ts";

export const reportSchema = z.object({
  machine: z.string(),
  repository: z.literal("connorch/skills"),
  cliVersion: z.string(),
  installed: z.object({ commit: z.string(), at: z.string() }).nullable(),
  attempt: z.object({
    id: z.string(),
    commit: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    outcome: z.enum(["success", "failed", "partial"]),
    error: z.string().nullable(),
    logKey: z.string(),
  }),
  changes: z.array(
    z.object({
      name: z.string(),
      action: z.enum(["install", "remove"]),
      agents: z.array(z.string()),
    }),
  ),
});
export type Report = z.infer<typeof reportSchema>;
export async function queueReport(root: string, report: Report) {
  await atomic(join(root, "outbox", `${report.attempt.id}.json`), report);
}

// Retries write each log at a fixed run key; status always describes the newest queued attempt.
export async function publish(
  root: string,
  home: string,
  endpoint = "https://files.wovn.org",
  fetcher = fetch,
) {
  const outbox = join(root, "outbox");
  if (!(await exists(outbox))) return;
  const entries = (await readdir(outbox))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!entries.length) return;
  const token = (
    await readFile(join(home, ".config", "wovn-files", "token.txt"), "utf8")
  ).trim();
  if (!token) throw new Error("Wovn token file is empty");
  const headers = {
    authorization: `Bearer ${token}`,
    "x-wovn-visibility": "private",
  };
  async function put(
    key: string,
    body: string,
    contentType: string,
    force = false,
  ) {
    const response = await fetcher(`${endpoint}/${key}`, {
      method: "PUT",
      headers: {
        ...headers,
        ...(force ? { "x-wovn-force": "1" } : {}),
        "content-type": contentType,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 409 && !force) return;
    if (!response.ok)
      throw new Error(`Wovn upload failed: HTTP ${response.status}`);
  }
  const reports = await Promise.all(
    entries.map((name) => json(join(outbox, name), reportSchema)),
  );
  for (const report of reports) {
    await put(
      report.attempt.logKey,
      await readFile(join(root, "logs", `${report.attempt.id}.log`), "utf8"),
      "text/plain",
    );
  }
  const latest = reports.at(-1)!;
  await put(
    `skills-fleet/${latest.machine}/status.json`,
    JSON.stringify(latest, null, 2) + "\n",
    "application/json",
    true,
  );
  for (const name of entries) await rm(join(outbox, name));
}

export function completeReport(
  machine: string,
  cliVersion: string,
  state: State,
  changes: Report["changes"],
): Report {
  return reportSchema.parse({
    machine,
    repository: "connorch/skills",
    cliVersion: state.attempt?.cliVersion ?? cliVersion,
    installed: state.installed,
    attempt: state.attempt,
    changes,
  });
}
