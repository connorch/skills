import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { output, next } from "../cli.ts";
import { PROVIDERS, type Config } from "../config.ts";
import {
  FollowUpLedger,
  HttpClient,
  InputError,
  ProviderError,
  TaskRef,
  formats,
  loadImage,
} from "./core.ts";
import { Generator, generationResult } from "./pipeline.ts";
import { createProvider } from "./providers.ts";
export * from "./core.ts";
export * from "./providers.ts";
export * from "./pipeline.ts";
export * from "./download.ts";
const optionsSchema = z.object({
  provider: z.enum(["meshy", "tripo", "rodin"]).optional(),
  model: z.string().optional(),
  wait: z.boolean().default(false),
  format: z.enum(formats).default("glb"),
  texture: z.boolean().default(true),
  timeout: z.coerce.number().positive().default(900),
  json: z.boolean().default(false),
  out: z.string().optional(),
  prompt: z.string().optional(),
});

// Adds the Generate Route without modifying the CLI entry point.
export function register(program: Command, config: Config, http = new HttpClient()): void {
  const group = program
    .command("generate")
    .description("generate a Model from text or an image with an AI provider");
  for (const verb of ["text", "image", "status", "download"] as const) {
    const command = group.command(
      `${verb} <${verb === "text" ? "prompt" : verb === "image" ? "image" : "task-id"}>`,
    );
    command
      .option("--provider <provider>")
      .option("--model <model>")
      .option("--wait")
      .option("--format <format>", "glb, stl, 3mf, or obj", "glb")
      .option("--no-texture")
      .option("--timeout <seconds>", "maximum wait", "900")
      .option("--out <directory>", "Model output directory")
      .option("--json");
    if (verb === "image") command.option("--prompt <prompt>", "optional guidance (Rodin)");
    command.action(async (value: string, raw: unknown) => {
      let task: TaskRef | undefined;
      let resumeFlags = "";
      let notConfigured = false;
      const json = typeof raw === "object" && raw !== null && "json" in raw && raw.json === true;
      try {
        const parsed = optionsSchema.safeParse(raw);
        if (!parsed.success)
          throw new InputError(parsed.error.issues[0]?.message || "invalid arguments");
        const options = parsed.data;
        resumeFlags = `${options.format !== "glb" ? ` --format ${options.format}` : ""}${!options.texture || options.format !== "glb" ? " --no-texture" : ""}`;
        const image = verb === "image" ? loadImage(value) : undefined;
        if (verb === "status" || verb === "download") task = TaskRef.parse(value);
        const settings = config.settings();
        const name = task?.provider ?? options.provider ?? settings["3d_provider"] ?? "meshy";
        const known = PROVIDERS.find((p) => p === name);
        // The selected provider's own key beats a generic one left for another.
        const key = known
          ? config.secret(`${known}_api_key`) || config.secret("3d_api_key", known)
          : config.secret("3d_api_key");
        if (!key) {
          notConfigured = true;
          throw new InputError(
            `No API key for ${name}. Save it with: bambu config secret ${name}_api_key`,
          );
        }
        const provider = createProvider(name, key, http, settings.rodin_tier);
        const generator = new Generator(
          provider,
          options.out ?? "./bambu-output/models",
          new FollowUpLedger(join(config.dir, "generation-tasks.json")),
        );
        const texture = options.texture && options.format === "glb";
        const result = await (async () => {
          if (task)
            return verb === "status"
              ? generator.status(task)
              : generator.complete(task, options.format, texture, options.timeout);
          if (image && options.prompt && !provider.image_prompt_supported)
            console.error(`${name} image-to-3D has no prompt field; --prompt was not sent.`);
          if (options.format !== "glb" && options.texture)
            console.error(
              `${options.format.toUpperCase()} carries no colour, so no texture is generated (saves credits).`,
            );
          task = await provider.create({
            prompt: verb === "text" ? value : options.prompt,
            image,
            model: options.model,
            output_format: options.format,
            texture,
          });
          const submitted = options.wait
            ? await generator.complete(
                task,
                options.format,
                texture,
                options.timeout,
                provider.poll_interval_s,
              )
            : generationResult(task, "submitted");
          submitted.prompt_used = image
            ? !!options.prompt && provider.image_prompt_supported
            : null;
          if (!options.wait)
            submitted.next_command += `${options.format !== "glb" ? ` --format ${options.format}` : ""}${!texture ? " --no-texture" : ""}`;
          return submitted;
        })();
        output(json, result, () =>
          [
            result.output_file
              ? `${result.format?.toUpperCase()} saved: ${result.output_file} (${result.has_texture ? "textured" : "no colour"})`
              : `${result.task_id}: ${result.status}${result.progress !== null ? ` ${result.progress}%` : ""}${result.message ? ` (${result.message})` : ""}`,
            ...result.warnings,
            next(result.next_command),
          ].join("\n"),
        );
        if (
          ["failed", "cancelled", "expired", "rejected"].includes(result.status) &&
          verb !== "status"
        )
          process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const resume = task ? `bambu generate download ${task.token}${resumeFlags}` : null;
        output(
          json,
          {
            error: {
              type: notConfigured
                ? "not_configured"
                : error instanceof InputError
                  ? "bad_input"
                  : "provider",
              message,
            },
            task_id: task?.token ?? null,
            next_command: resume,
          },
          () => `bambu: ${message}${resume ? `\n${next(resume)}` : ""}`,
        );
        if (json) console.error(`bambu: ${message}`);
        if (error instanceof ProviderError && error.code === "network" && !task)
          console.error(
            "The request may have reached the provider. Check its dashboard before submitting again to avoid paying twice.",
          );
        process.exitCode = error instanceof InputError ? 2 : 1;
      }
    });
  }
}
