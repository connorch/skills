import { fetchListedOutput } from "./download.ts";
import {
  HttpClient,
  InputError,
  ProviderError,
  TaskRef,
  formatFromName,
  imageMime,
  object,
  status,
  uploadName,
  type OutputFormat,
  type Provider,
  type State,
  type Status,
} from "./core.ts";

const meshyRoutes: Record<string, string> = {
  text: "v2/text-to-3d",
  preview: "v2/text-to-3d",
  refine: "v2/text-to-3d",
  image: "v1/image-to-3d",
  convert: "v1/convert",
};
export function parseMeshyTask(value: unknown): Status {
  const task = object(value);
  const raw = String(task.status ?? "");
  const states: Record<string, State> = {
    PENDING: "queued",
    IN_PROGRESS: "running",
    SUCCEEDED: "succeeded",
    FAILED: "failed",
    CANCELED: "cancelled",
    CANCELLED: "cancelled",
  };
  const state = states[raw.toUpperCase()] ?? "running";
  let message = task.task_error ? String(object(task.task_error).message || "") : "";
  if (!states[raw.toUpperCase()]) message = `unrecognised Meshy status '${raw}'`;
  else if (state === "cancelled") message ||= "the task was cancelled at Meshy";
  const outputs = Object.fromEntries(
    Object.entries(task.model_urls ? object(task.model_urls) : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1],
    ),
  );
  return status(state, {
    raw_status: raw,
    message,
    outputs,
    progress: typeof task.progress === "number" ? Math.trunc(task.progress) : null,
  });
}
function tripoData(value: unknown): Record<string, unknown> {
  const body = object(value);
  if ((body.code ?? 0) !== 0)
    throw new ProviderError(
      String(body.code),
      `${String(body.message || "Tripo error")}${body.suggestion ? `. ${String(body.suggestion)}` : ""}`,
    );
  return object(body.data);
}
export function parseTripoTask(value: unknown, converted?: OutputFormat): Status {
  const task = object(value);
  const raw = String(task.status ?? "");
  const key = raw.toLowerCase();
  const states: Record<string, State> = {
    queued: "queued",
    running: "running",
    success: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
    banned: "rejected",
    expired: "expired",
    unknown: "failed",
  };
  const notes: Record<string, string> = {
    banned: "Tripo rejected the input under its content policy; change the prompt or image",
    expired: "the task expired at Tripo and its files are gone",
    cancelled: "the task was cancelled at Tripo (its credits are refunded)",
    unknown: "Tripo reports the task status as unknown; contact Tripo support with the task id",
  };
  const fields = task.output ? object(task.output) : {};
  const url = ["model_url", "pbr_model", "model", "base_model"]
    .map((k) => fields[k])
    .find((v) => typeof v === "string" && v);
  return status(states[key] ?? "running", {
    raw_status: raw,
    progress: typeof task.progress === "number" ? Math.trunc(task.progress) : null,
    message: task.error_message
      ? `${String(task.error_message)} (error ${String(task.error_code ?? "?")})`
      : states[key]
        ? notes[key] || ""
        : `unrecognised Tripo status '${raw}'`,
    outputs: typeof url === "string" ? { [converted ?? formatFromName(url) ?? "glb"]: url } : {},
  });
}
function checkedRodin(value: unknown): Record<string, unknown> {
  const body = object(value);
  if (body.error)
    throw new ProviderError(
      String(body.error),
      String(body.message || "Rodin rejected the request"),
    );
  return body;
}
export function parseRodinStatus(value: unknown): Status {
  const body = object(value);
  if (body.error === "NO_SUCH_TASK")
    return status("expired", {
      message: "Rodin has no such task (it expired, or the id is wrong)",
      raw_status: "NO_SUCH_TASK",
    });
  checkedRodin(body);
  const jobs = Array.isArray(body.jobs)
    ? body.jobs.filter((v) => typeof v === "object" && v !== null).map(object)
    : [];
  const states = jobs.map((j) => String(j.status ?? ""));
  const raw_status = states.join(",");
  const done = states.filter((s) => s === "Done").length;
  if (states.includes("Failed"))
    return status("failed", { message: "a Rodin job failed", raw_status });
  if (states.length && done === states.length)
    return status("succeeded", { progress: 100, raw_status });
  const progress = states.length ? Math.trunc((100 * done) / states.length) : 0;
  if (states.includes("Generating") || done) return status("running", { progress, raw_status });
  const queue = jobs.find((j) => j.queue_length != null)?.queue_length;
  return status("queued", {
    progress,
    raw_status,
    message: queue != null ? `${String(queue)} jobs ahead in the queue` : "",
  });
}
export function parseRodinFiles(value: unknown): Record<string, string> {
  const body = checkedRodin(value);
  const outputs: Record<string, string> = {};
  for (const item of Array.isArray(body.list) ? body.list : []) {
    const entry = object(item);
    const format = formatFromName(String(entry.name ?? ""));
    if (format && typeof entry.url === "string" && entry.url && !outputs[format])
      outputs[format] = entry.url;
  }
  return outputs;
}

// Each provider shares the create/poll/download contract and keeps paid steps explicit.
export function createProvider(
  name: string,
  key: string,
  http = new HttpClient(),
  tier = "Gen-2.5-Medium",
): Provider {
  if (!["meshy", "tripo", "rodin"].includes(name))
    throw new InputError(`unknown provider '${name}'; choose meshy, tripo, rodin`);
  const base =
    name === "meshy"
      ? "https://api.meshy.ai/openapi"
      : name === "tripo"
        ? "https://openapi.tripo3d.ai/v3"
        : "https://api.hyper3d.com/api/v2";
  const headers = { Authorization: `Bearer ${key}` };
  const post = (route: string, body: unknown) =>
    http.json(`${base}/${route}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const multipart = (route: string, form: FormData) =>
    http.json(`${base}/${route}`, { method: "POST", headers, body: form });
  async function create(route: string, body: unknown, kind: string): Promise<TaskRef> {
    const reply = await post(route, body);
    const data = name === "tripo" ? tripoData(reply) : object(reply);
    const id = name === "tripo" ? data.task_id : data.result;
    if (typeof id !== "string" || !id)
      throw new ProviderError("bad_response", `${name} returned no task id`);
    return new TaskRef(name, kind, [id]);
  }
  function rodinIds(ref: TaskRef): [string, string] {
    if (ref.kind !== "task" || ref.ids.length !== 2)
      throw new InputError("a Rodin task id has the form rodin:task:<uuid>:<subscription key>");
    return [ref.ids[0]!, ref.ids[1]!];
  }
  const provider: Provider = {
    name,
    image_prompt_supported: name === "rodin",
    poll_interval_s: name === "tripo" ? 3 : 5,
    max_poll_interval_s: name === "rodin" ? 30 : name === "tripo" ? 15 : 20,
    async create(request) {
      if (!request.image && !request.prompt) throw new InputError("a text prompt is required");
      if (name === "meshy") {
        const target = request.output_format === "3mf" ? { target_formats: ["glb", "3mf"] } : {};
        if (!request.image)
          return create(
            "v2/text-to-3d",
            {
              mode: "preview",
              prompt: request.prompt,
              ai_model: request.model || "latest",
              ...target,
            },
            request.texture ? "text" : "preview",
          );
        const image = request.image;
        if (!image.url && !["image/png", "image/jpeg"].includes(image.mime || ""))
          throw new InputError(`Meshy accepts PNG or JPEG images, not ${image.mime}`);
        return create(
          "v1/image-to-3d",
          {
            image_url: image.url || `data:${image.mime};base64,${image.data?.toString("base64")}`,
            ai_model: request.model || "latest",
            should_texture: request.texture,
            ...target,
          },
          "image",
        );
      }
      if (name === "tripo") {
        const common = {
          model: request.model || "v3.1-20260211",
          ...(!request.texture ? { texture: false, pbr: false } : {}),
        };
        if (!request.image)
          return create("generation/text-to-model", { prompt: request.prompt, ...common }, "task");
        const image = request.image;
        let source = image.url;
        if (!source) {
          if (!image.data || !["image/png", "image/jpeg"].includes(image.mime || ""))
            throw new InputError(`Tripo's upload accepts PNG or JPEG images, not ${image.mime}`);
          const form = new FormData();
          form.append(
            "file",
            new Blob([new Uint8Array(image.data)], { type: image.mime }),
            uploadName(image),
          );
          const uploaded = tripoData(await multipart("files", form));
          if (typeof uploaded.file_token !== "string" || !uploaded.file_token)
            throw new ProviderError("bad_response", "Tripo's upload returned no file_token");
          source = uploaded.file_token;
        }
        return create("generation/image-to-model", { input: source, ...common }, "task");
      }
      const form = new FormData();
      if (request.image) {
        let image = request.image;
        if (image.url) {
          const response = await http.send(image.url);
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (response.body)
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 20 * 1024 * 1024)
                throw new InputError("the image URL points to a file larger than 20 MB");
              chunks.push(chunk);
            }
          const data = Buffer.concat(chunks);
          const mime = imageMime(data);
          if (!mime) throw new InputError(`${image.url} did not return a PNG, JPEG or WebP image`);
          image = { name: image.name, data, mime };
        }
        if (!image.data) throw new InputError("the image has no data");
        form.append(
          "images",
          new Blob([new Uint8Array(image.data)], { type: image.mime }),
          uploadName(image),
        );
      }
      if (request.prompt) form.append("prompt", request.prompt);
      form.append("tier", request.model || tier || "Gen-2.5-Medium");
      form.append(
        "geometry_file_format",
        request.output_format === "3mf" ? "glb" : request.output_format,
      );
      form.append("material", request.texture ? "PBR" : "None");
      const body = checkedRodin(await multipart("rodin", form));
      const subscription = body.jobs ? object(body.jobs).subscription_key : undefined;
      if (
        typeof body.uuid !== "string" ||
        !body.uuid ||
        typeof subscription !== "string" ||
        !subscription
      )
        throw new ProviderError(
          "bad_response",
          "Rodin accepted the request but returned no task id",
        );
      return new TaskRef(name, "task", [body.uuid, subscription]);
    },
    async poll(ref) {
      if (name === "rodin")
        return parseRodinStatus(await post("status", { subscription_key: rodinIds(ref)[1] }));
      if (name === "meshy") {
        const route = meshyRoutes[ref.kind];
        if (!route) throw new InputError(`unknown Meshy task kind '${ref.kind}'`);
        return parseMeshyTask(
          await http.json(`${base}/${route}/${encodeURIComponent(ref.primary_id)}`, { headers }),
        );
      }
      const converted =
        ref.kind === "convert" && (ref.ids[1] === "stl" || ref.ids[1] === "3mf")
          ? ref.ids[1]
          : undefined;
      return parseTripoTask(
        tripoData(
          await http.json(`${base}/tasks/${encodeURIComponent(ref.primary_id)}`, { headers }),
        ),
        converted,
      );
    },
    followUp(ref, observation, format, texture) {
      let action: string | undefined;
      let description = "";
      if (name === "meshy" && ref.kind === "text" && format === "glb" && texture) {
        action = "refine";
        description = "Meshy texture step (refine, 10 credits)";
      } else if (
        name === "meshy" &&
        format !== "glb" &&
        !observation.outputs[format] &&
        ref.kind !== "convert"
      ) {
        action = `convert:${format}`;
        description = `Meshy server-side ${format.toUpperCase()} conversion (1 credit)`;
      } else if (
        name === "tripo" &&
        ref.kind === "task" &&
        ["stl", "3mf"].includes(format) &&
        !observation.outputs[format]
      ) {
        action = `convert:${format}`;
        description = `Tripo server-side ${format.toUpperCase()} conversion (5 credits)`;
      }
      return action
        ? { key: `${ref.token}>${action}`, action, source: ref, description }
        : undefined;
    },
    async startFollowUp(step) {
      if (name === "meshy" && step.action === "refine")
        return create(
          "v2/text-to-3d",
          { mode: "refine", preview_task_id: step.source.primary_id },
          "refine",
        );
      const target = step.action.split(":")[1];
      if (name === "meshy" && step.action.startsWith("convert:"))
        return create(
          "v1/convert",
          { input_task_id: step.source.primary_id, target_formats: [target] },
          "convert",
        );
      if (
        name === "tripo" &&
        step.action.startsWith("convert:") &&
        (target === "stl" || target === "3mf")
      ) {
        const ref = await create(
          "models/convert",
          { input: step.source.primary_id, format: target.toUpperCase() },
          "task",
        );
        return new TaskRef(name, "convert", [ref.primary_id, target]);
      }
      throw new InputError(`unknown ${name} step '${step.action}'`);
    },
    download(ref, format, dir) {
      const listing =
        name === "rodin"
          ? async () =>
              status("succeeded", {
                outputs: parseRodinFiles(await post("download", { task_uuid: rodinIds(ref)[0] })),
              })
          : () => provider.poll(ref);
      return fetchListedOutput(http, listing, format, dir, `${name}_${ref.primary_id}`);
    },
  };
  return provider;
}
