// Conventions every bambu command follows, so the agent reading the output
// (and the tests) can rely on them:
//   - exit 0 when the command ran, 1 when it failed, 2 for bad arguments;
//   - `--json` prints exactly one JSON document on stdout and nothing else;
//   - human output ends with a `➡️` line saying what to do next, when there is a next step.

export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export function fail(message: string, code = EXIT_FAILED): never {
  console.error(`bambu: ${message}`);
  process.exit(code);
}

// Print either the JSON document or the human lines, never both.
export function output(json: boolean, doc: unknown, human: () => string): void {
  console.log(json ? JSON.stringify(doc, null, 2) : human());
}

// Bad arguments, as opposed to a command that ran and failed.
export class UsageError extends Error {}

// Whether `--json` was asked for, read from Commander's raw options so the
// contract holds even when the options themselves fail to parse.
export function jsonFlag(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "json" in raw && raw.json === true;
}

// Report a command's error the one way: the error document under --json
// (`type` is "usage" for a UsageError, else `failedType`), the message on
// stderr, and exit 2 or 1.
export function reportError(json: boolean, error: unknown, failedType = "failed"): void {
  const message = error instanceof Error ? error.message : String(error),
    usage = error instanceof UsageError;
  if (json) output(true, { error: { type: usage ? "usage" : failedType, message } }, () => "");
  console.error(`bambu: ${message}`);
  process.exitCode = usage ? EXIT_USAGE : EXIT_FAILED;
}

// POSIX single quoting for a path echoed into a suggested command line.
export function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function next(text: string): string {
  return `➡️ ${text}`;
}
