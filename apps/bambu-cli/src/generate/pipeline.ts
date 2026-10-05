import {
  FollowUpLedger,
  ProviderError,
  TaskRef,
  sleep,
  status,
  terminal,
  type OutputFormat,
  type Provider,
  type Status,
} from "./core.ts";
import { hasTexture } from "./download.ts";

// Injectable timing makes polling tests instantaneous.
export async function waitForTask(
  poll: () => Promise<Status>,
  options: {
    timeout_s: number;
    interval_s: number;
    max_interval_s: number;
    initial_delay_s?: number;
    sleep?: typeof sleep;
    clock?: () => number;
  },
) {
  const pause = options.sleep ?? sleep;
  const clock = options.clock ?? (() => performance.now() / 1000);
  const deadline = clock() + options.timeout_s;
  let delay = options.interval_s;
  let last = status("queued", { message: "not checked yet" });
  let last_error = "";
  if (options.initial_delay_s)
    await pause(Math.min(options.initial_delay_s, Math.max(deadline - clock(), 0)));
  for (;;) {
    try {
      last = await poll();
      last_error = "";
      if (terminal(last.state)) return { status: last, timed_out: false, last_error };
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      last_error = error.message;
    }
    const remaining = deadline - clock();
    if (remaining <= 0) return { status: last, timed_out: true, last_error };
    await pause(Math.min(delay, remaining));
    delay = Math.min(delay * 1.5, options.max_interval_s);
  }
}
export function generationResult(ref: TaskRef, observation: Status | "submitted") {
  return {
    task_id: ref.token,
    provider: ref.provider,
    status: observation === "submitted" ? "submitted" : observation.state,
    output_file: null as string | null,
    format: null as OutputFormat | null,
    extents_mm: null,
    has_texture: null as boolean | null,
    progress: observation === "submitted" ? null : observation.progress,
    message: observation === "submitted" ? "" : observation.message,
    warnings: [] as string[],
    prompt_used: null as boolean | null,
    next_command: `bambu generate download ${ref.token}`,
  };
}
export type GenerationResult = ReturnType<typeof generationResult>;

// Only complete starts paid follow-ups; status merely reads their recorded ids.
export class Generator {
  constructor(
    readonly provider: Provider,
    readonly output_dir: string,
    readonly ledger: FollowUpLedger,
    readonly pause = sleep,
    readonly clock = () => performance.now() / 1000,
  ) {}
  async status(
    ref: TaskRef,
    format: OutputFormat = "glb",
    texture = true,
  ): Promise<GenerationResult> {
    const recorded = this.ledger.startedFrom(ref.token);
    const current = recorded ? TaskRef.parse(recorded) : ref;
    const observation = await this.provider.poll(current);
    const result = generationResult(current, observation);
    if (observation.state === "succeeded") {
      const step = this.provider.followUp(current, observation, format, texture);
      if (step) result.message = `finished; \`download\` starts the ${step.description}`;
    }
    return result;
  }
  async complete(
    ref: TaskRef,
    format: OutputFormat = "glb",
    texture = true,
    timeout_s = 900,
    first_delay_s = 0,
  ): Promise<GenerationResult> {
    const deadline = this.clock() + timeout_s;
    let current = ref;
    let delay = first_delay_s;
    for (;;) {
      const outcome = await waitForTask(() => this.provider.poll(current), {
        timeout_s: Math.max(deadline - this.clock(), 0),
        interval_s: this.provider.poll_interval_s,
        max_interval_s: this.provider.max_poll_interval_s,
        initial_delay_s: delay,
        sleep: this.pause,
        clock: this.clock,
      });
      const result = generationResult(current, outcome.status);
      result.next_command += `${format !== "glb" ? ` --format ${format}` : ""}${!texture ? " --no-texture" : ""}`;
      if (outcome.timed_out) {
        result.message = outcome.last_error || "still running at the provider";
        return result;
      }
      if (outcome.status.state !== "succeeded") return result;
      const step = this.provider.followUp(current, outcome.status, format, texture);
      if (!step) {
        const fetched = await this.provider.download(current, format, this.output_dir);
        result.output_file = fetched.path;
        result.format = fetched.output_format;
        result.has_texture = hasTexture(fetched.path, fetched.output_format);
        result.progress = 100;
        if (fetched.output_format === format && format !== "glb")
          result.warnings.push(
            `${format.toUpperCase()} carries no colour; the default GLB output keeps the texture`,
          );
        if (fetched.output_format !== format)
          result.warnings.push(
            `this task only has ${fetched.output_format.toUpperCase()}, not ${format.toUpperCase()}; kept ${fetched.output_format.toUpperCase()}`,
          );
        result.next_command = `bambu analyze ${JSON.stringify(fetched.path)} --height <mm>`;
        return result;
      }
      const recorded = this.ledger.get(step.key);
      if (recorded) current = TaskRef.parse(recorded);
      else {
        current = await this.provider.startFollowUp(step);
        this.ledger.record(step.key, current.token);
      }
      delay = this.provider.poll_interval_s;
    }
  }
}
