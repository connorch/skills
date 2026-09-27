// jevx - Jev (TypeSafe's decision model) on this Machine. The agent-facing usage
// guide is skills/jev/SKILL.md.
//
//   jevx classify  one Jev Choice per input line, run concurrently, as JSONL
//   jevx browse    one jev-ultrafast goal in the Agents Chrome, as a JSON report
//   jevx harness   browser-harness from the same environment, for scripting that Chrome
//
// `browse` and `harness` run inside a jev-ultrafast clone (JEV_ULTRAFAST, default
// ~/Projects/jev-ultrafast) so both share browser-harness's one CDP connection to
// Chrome, and Chrome asks "Allow remote debugging?" once per connection, not per run.
//
// Key resolution: ~/.config/typesafe/api_key.txt first, TYPESAFE_API_KEY second.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { Command, InvalidArgumentError } from "commander";

const KEY_FILE = join(homedir(), ".config", "typesafe", "api_key.txt");
const JEV_ULTRAFAST = process.env.JEV_ULTRAFAST ?? join(homedir(), "Projects", "jev-ultrafast");
// jev-ultrafast's TYPE_TEXT helper: a local Ollama model unless the environment overrides it.
const TEXT_MODEL_DEFAULTS = {
  TEXT_MODEL_API_KEY: "ollama",
  TEXT_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
  TEXT_MODEL: "gemma4:26b",
};

function fail(message: string): never {
  console.error(`jevx: ${message}`);
  process.exit(1);
}

function apiKey(): string {
  try {
    return readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    return (
      process.env.TYPESAFE_API_KEY ?? fail(`no key at ${KEY_FILE} and TYPESAFE_API_KEY is unset`)
    );
  }
}

// "a,b" or "a=description,b=description" -> Choice criteria.
function parseOptions(raw: string): Record<string, string | null> {
  return Object.fromEntries(
    raw.split(",").map((part) => {
      const [name = "", ...description] = part.split("=");
      return [name.trim(), description.join("=").trim() || null];
    }),
  );
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

// Maps with at most `limit` calls in flight, keeping input order. Workers share one iterator.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = [];
  const queue = items.entries();
  const worker = async () => {
    for (const [index, item] of queue) results[index] = await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface ClassifyOptions {
  options: string;
  instructions: string;
  in?: string;
  out?: string;
  concurrency: number;
  low: number;
}

async function classify(opts: ClassifyOptions) {
  const question = choice(opts.instructions, parseOptions(opts.options));
  const items = readFileSync(opts.in ?? process.stdin.fd, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const client = new TypeSafeClient({ apiKey: apiKey() });
  const rows = await mapPool(items, opts.concurrency, async (item) => {
    const { answers } = await client.systemOne({ state: item, questions: { label: question } });
    const { choice: label, confidence, probabilities } = answers.label;
    return { item, choice: label, confidence, probabilities };
  });

  const jsonl = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  if (opts.out) writeFileSync(opts.out, jsonl);
  else process.stdout.write(jsonl);

  // The summary goes to stderr so bulk rows never have to enter an agent's context.
  const counts = Object.fromEntries(
    Object.keys(question.criteria).map((name) => [
      name,
      rows.filter((row) => row.choice === name).length,
    ]),
  );
  const uncertain = rows.filter((row) => row.confidence < opts.low);
  console.error(JSON.stringify({ items: rows.length, counts, uncertain: uncertain.length }));
  for (const row of uncertain) {
    console.error(
      `  uncertain: ${JSON.stringify(row.item)} -> ${row.choice} (${row.confidence.toFixed(2)})`,
    );
  }
}

// Runs a command in the jev-ultrafast environment and resolves with its exit code.
function uvRun(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!existsSync(join(JEV_ULTRAFAST, "pyproject.toml"))) {
    fail(`no jev-ultrafast clone at ${JEV_ULTRAFAST} (set JEV_ULTRAFAST)`);
  }
  return new Promise((resolve) => {
    spawn("uv", ["run", "--quiet", "--project", JEV_ULTRAFAST, ...args], { stdio: "inherit", env })
      .on("error", (error) => fail(`could not run uv: ${error.message}`))
      .on("close", (code) => resolve(code ?? 1));
  });
}

// Runs jev-ultrafast's Agent and prints one JSON report: status, steps, and the final
// page text, so the caller can verify the outcome itself (DONE is not proof).
const BROWSE_PY = `
import json, sys
from jev_ultrafast import Agent

opts = json.loads(sys.argv[1])
report, agent, printed = {}, None, 0
try:
    agent = Agent(opts["url"], opts["goals"])
    for state in agent.run():
        for step in [] if opts["quiet"] else state["history"][printed:]:
            print(f"{step['elapsed_ms']:>6} ms  {step['kind']:<6} {step['action']}", file=sys.stderr, flush=True)
        printed = len(state["history"])
except Exception as error:
    report["error"] = f"{type(error).__name__}: {error}"
if agent:
    state = agent.snapshot()
    report.update(
        status="error" if "error" in report else state["status"],
        elapsed_ms=state["elapsed_ms"],
        url=state["page"]["url"],
        title=state["page"]["title"],
        steps=[{k: h.get(k) for k in ("action", "kind", "text", "probability", "page_changed")} for h in state["history"]],
        page_text=state["page"]["text"],
        target_id=agent.browser.target if opts["keepOpen"] else None,
    )
    if not opts["keepOpen"]:
        agent.close()
print(json.dumps({"status": "error", **report}, ensure_ascii=False, indent=2))
sys.exit(0 if report.get("status") == "done" else 1)
`;

interface BrowseOptions {
  url: string;
  goal: string[];
  keepOpen: boolean;
  quiet: boolean;
}

async function browse(opts: BrowseOptions) {
  const env = { ...TEXT_MODEL_DEFAULTS, ...process.env, TYPESAFE_API_KEY: apiKey() };
  // Warm a local Ollama model in parallel so the first TYPE_TEXT skips the load.
  if (env.TEXT_MODEL_BASE_URL.includes(":11434")) {
    fetch(env.TEXT_MODEL_BASE_URL.replace(/\/v1\/?$/, "/api/generate"), {
      method: "POST",
      body: JSON.stringify({ model: env.TEXT_MODEL, keep_alive: "30m" }),
    }).catch(() => {});
  }
  const args = { url: opts.url, goals: opts.goal, keepOpen: opts.keepOpen, quiet: opts.quiet };
  process.exit(await uvRun(["python", "-c", BROWSE_PY, JSON.stringify(args)], env));
}

const program = new Command("jevx")
  .description("Jev decisions and Jev-driven browsing on this Machine")
  .enablePositionalOptions();

program
  .command("classify")
  .description("classify every input line into one option; JSONL out, summary on stderr")
  .requiredOption("--options <list>", '"a,b,c" or "a=description,b=description"')
  .option("--instructions <text>", "the question", "Which option best fits this item?")
  .option("--in <file>", "one item per line (default: stdin)")
  .option("--out <file>", "JSONL output (default: stdout)")
  .option("--concurrency <n>", "requests in flight", positiveInt, 16)
  .option("--low <confidence>", "report rows below this confidence", Number.parseFloat, 0.5)
  .action(classify);

program
  .command("browse")
  .description("run one Jev-driven browser goal in the Agents Chrome; JSON report out")
  .requiredOption("--url <url>", "starting page")
  .requiredOption(
    "--goal <text>",
    "the goal; repeat for an ordered list",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option("--keep-open", "leave the tab open for follow-up scripting", false)
  .option("--quiet", "no per-step progress on stderr", false)
  .action(browse);

program
  .command("harness")
  .description("browser-harness in the same environment (e.g. jevx harness <<'PY' ... PY)")
  .argument("[args...]", "passed through to browser-harness")
  .passThroughOptions()
  .allowUnknownOption()
  .helpOption(false)
  .action(async (args: string[]) => process.exit(await uvRun(["browser-harness", ...args])));

await program.parseAsync();
