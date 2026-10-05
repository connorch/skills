import { readFile } from "node:fs/promises";
import { extname, basename, dirname, resolve } from "node:path";
import { NodeIO, type GLTF, type Node } from "@gltf-transform/core";
import { UPRIGHT_NODE } from "../generate/download.ts";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { linearToSrgb, srgbToLinear, roundEven, type Vec3, type Vec4 } from "./lab.ts";
import type { Face } from "./segment.ts";
export interface Texture {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface Part {
  start: number;
  end: number;
  texture?: Texture;
  factor: Vec4;
  alphaMode: string;
  alphaCutoff: number;
  hasColour: boolean;
}
export interface ColouredModel {
  vertices: Vec3[];
  faces: Face[];
  uv: [number, number][];
  vertexColours: Vec4[];
  parts: Part[];
  warnings: string[];
  // True when glTF Y-up coordinates were turned Z-up for the printer.
  turned: boolean;
}
export class ModelLoadError extends Error {}
export class NoColourError extends Error {}
export type ReadFile = (path: string) => Promise<Uint8Array>;
export function decodeTexture(bytes: Uint8Array): Texture {
  const png =
    bytes[0] === 0xff && bytes[1] === 0xd8
      ? jpeg.decode(bytes, { useTArray: true })
      : PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: png.data };
}
// Read scene transforms and each primitive's own colour source without welding UV seams.
export async function loadColouredModel(
  path: string,
  read: ReadFile = readFile,
): Promise<ColouredModel> {
  const suffix = extname(path).toLowerCase();
  if (![".glb", ".gltf", ".obj"].includes(suffix))
    throw new ModelLoadError(
      `${basename(path)}: unsupported format ${suffix || "(none)"}; use GLB, glTF or OBJ`,
    );
  const model: ColouredModel = {
    vertices: [],
    faces: [],
    uv: [],
    vertexColours: [],
    parts: [],
    warnings: [],
    turned: false,
  };
  try {
    if (suffix === ".obj") await loadObj(path, read, model);
    else {
      const io = new NodeIO();
      const bytes = await read(path);
      const document =
        suffix === ".glb"
          ? await io.readBinary(bytes)
          : await (async () => {
              const json = JSON.parse(Buffer.from(bytes).toString()) as GLTF.IGLTF;
              const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
              for (const item of [...(json.buffers ?? []), ...(json.images ?? [])])
                if (item.uri && !item.uri.startsWith("data:"))
                  resources[item.uri] = new Uint8Array(
                    await read(resolve(dirname(path), decodeURIComponent(item.uri))),
                  );
              return io.readJSON({ json, resources });
            })();
      // Only what the default scene shows; a GLB can carry other scenes or
      // staging nodes that are not part of the Model.
      const root = document.getRoot(),
        scene = root.getDefaultScene() ?? root.listScenes()[0],
        shown = new Set<Node>();
      if (scene) scene.traverse((node) => shown.add(node));
      // A generated GLB was already turned Z-up by its upright root node
      // (generate/download.ts); only a raw glTF needs the Y-up conversion.
      const zUp = root.listNodes().some((n) => n.getName() === UPRIGHT_NODE);
      model.turned = !zUp;
      const toPrinter = (w: number[]): Vec3 =>
        zUp
          ? [w[0]! * 1000, w[1]! * 1000, w[2]! * 1000]
          : [w[0]! * 1000, -w[2]! * 1000, w[1]! * 1000];
      for (const node of shown) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        const matrix = node.getWorldMatrix();
        const determinant =
          matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) -
          matrix[4]! * (matrix[1]! * matrix[10]! - matrix[2]! * matrix[9]!) +
          matrix[8]! * (matrix[1]! * matrix[6]! - matrix[2]! * matrix[5]!);
        for (const primitive of mesh.listPrimitives()) {
          if (primitive.getMode() !== 4) continue;
          const positions = primitive.getAttribute("POSITION");
          if (!positions) continue;
          const uv = primitive.getAttribute("TEXCOORD_0"),
            colors = primitive.getAttribute("COLOR_0"),
            material = primitive.getMaterial();
          const offset = model.vertices.length,
            start = model.faces.length;
          for (let i = 0; i < positions.getCount(); i++) {
            const p = positions.getElement(i, []),
              x = p[0]!,
              y = p[1]!,
              z = p[2]!;
            const world = [
              matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
              matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
              matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
            ];
            model.vertices.push(toPrinter(world));
            const tex = uv?.getElement(i, []) ?? [0, 0];
            model.uv.push([tex[0]!, 1 - tex[1]!]);
            // Upstream's trimesh reader quantises vertex RGBA to 8 bits before decoding linear light.
            const c = (colors?.getElement(i, []) ?? [1, 1, 1, 1]).map(
              (v) => roundEven(v * 255) / 255,
            );
            model.vertexColours.push([
              linearToSrgb(c[0]!),
              linearToSrgb(c[1]!),
              linearToSrgb(c[2]!),
              c[3] ?? 1,
            ]);
          }
          const indices = primitive.getIndices();
          const ids = indices
            ? Array.from({ length: indices.getCount() }, (_, i) => indices.getScalar(i))
            : Array.from({ length: positions.getCount() }, (_, i) => i);
          for (let i = 0; i + 2 < ids.length; i += 3) {
            const face: Face = [ids[i]! + offset, ids[i + 1]! + offset, ids[i + 2]! + offset];
            model.faces.push(determinant < 0 ? [face[2], face[1], face[0]] : face);
          }
          const image = material?.getBaseColorTexture()?.getImage(),
            factor = material?.getBaseColorFactor() ?? [1, 1, 1, 1];
          if (image && !uv)
            model.warnings.push(
              `${mesh.getName()}: has a texture but no texture coordinates; using the material colour`,
            );
          model.parts.push({
            start,
            end: model.faces.length,
            ...(image && uv ? { texture: decodeTexture(image) } : {}),
            factor: [factor[0]!, factor[1]!, factor[2]!, factor[3]!],
            alphaMode: material?.getAlphaMode() ?? "OPAQUE",
            alphaCutoff: material?.getAlphaCutoff() ?? 0.5,
            hasColour:
              Boolean(image && uv) || Boolean(colors) || factor.some((v) => Math.abs(v - 1) > 1e-5),
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new ModelLoadError(`file not found: ${path}`);
    throw new ModelLoadError(
      `could not read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!model.faces.length) throw new ModelLoadError(`${basename(path)} contains no triangles`);
  if (!model.parts.some((p) => p.hasColour))
    throw new NoColourError(
      `${basename(path)} has no base-colour texture, vertex colours or material colours; there is nothing to turn into filament colours`,
    );
  return model;
}
// OBJ numbers are millimetres; MTL diffuse colours are display sRGB.
async function loadObj(path: string, read: ReadFile, model: ColouredModel) {
  const text = Buffer.from(await read(path)).toString(),
    positions: Vec3[] = [],
    uvs: [number, number][] = [],
    colours: Vec4[] = [];
  const materials = new Map<string, { factor: Vec4; texture?: Texture }>();
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...words] = line.trim().split(/\s+/);
    if (kind === "mtllib") {
      for (const file of words) {
        const materialPath = resolve(dirname(path), file);
        const mtl = Buffer.from(await read(materialPath)).toString();
        let current: { factor: Vec4; texture?: Texture } | undefined;
        for (const row of mtl.split(/\r?\n/)) {
          const [key, ...args] = row.trim().split(/\s+/);
          if (key === "newmtl") {
            current = { factor: [1, 1, 1, 1] };
            materials.set(args.join(" "), current);
          }
          if (!current) continue;
          if (key === "Kd")
            current.factor = [
              srgbToLinear(Number(args[0])),
              srgbToLinear(Number(args[1])),
              srgbToLinear(Number(args[2])),
              current.factor[3],
            ];
          if (key === "d") current.factor[3] = Number(args[0]);
          if (key === "map_Kd")
            current.texture = decodeTexture(
              await read(resolve(dirname(materialPath), args.join(" "))),
            );
        }
      }
    }
    if (kind === "v") {
      const v = words.map(Number);
      positions.push([v[0]!, -v[2]!, v[1]!]);
      colours.push(v.length >= 6 ? [v[3]!, v[4]!, v[5]!, 1] : [1, 1, 1, 1]);
    }
    if (kind === "vt") uvs.push([Number(words[0]), Number(words[1])]);
  }
  let name = "";
  const index = (text: string, length: number) =>
    Number(text) < 0 ? length + Number(text) : Number(text) - 1;
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...words] = line.trim().split(/\s+/);
    if (kind === "usemtl") name = words.join(" ");
    if (kind !== "f" || words.length < 3) continue;
    const start = model.faces.length,
      offset = model.vertices.length;
    let hasUv = true,
      hasVertex = false;
    for (const word of words) {
      const [v, t] = word.split("/"),
        id = index(v!, positions.length);
      model.vertices.push(positions[id]!);
      model.vertexColours.push(colours[id]!);
      hasVertex ||= colours[id]!.some((c) => c !== 1);
      if (!t) hasUv = false;
      model.uv.push(t ? uvs[index(t, uvs.length)]! : [0, 0]);
    }
    for (let i = 1; i < words.length - 1; i++)
      model.faces.push([offset, offset + i, offset + i + 1]);
    const material = materials.get(name),
      factor = material?.factor ?? [1, 1, 1, 1];
    const part: Part = {
      start,
      end: model.faces.length,
      factor,
      alphaMode: "OPAQUE",
      alphaCutoff: 0.5,
      hasColour:
        hasVertex ||
        factor.some((v) => Math.abs(v - 1) > 1e-5) ||
        Boolean(material?.texture && hasUv),
      ...(material?.texture && hasUv ? { texture: material.texture } : {}),
    };
    const previous = model.parts.at(-1);
    if (
      previous &&
      previous.texture === part.texture &&
      previous.hasColour === part.hasColour &&
      previous.factor.every((v, i) => v === part.factor[i])
    )
      previous.end = part.end;
    else model.parts.push(part);
  }
}
