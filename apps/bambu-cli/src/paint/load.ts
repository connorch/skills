import { readFile } from "node:fs/promises";
import { extname, basename } from "node:path";
import { NodeIO, type GLTF, type Node } from "@gltf-transform/core";
import { UPRIGHT_NODES } from "../generate/download.ts";
import { companionPath } from "../mesh/load.ts";
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
// Textures past this many pixels (a 256 MB RGBA bitmap) are refused before
// decoding; the header carries the size, so the file is never expanded first.
export const MAX_TEXTURE_PIXELS = 64 * 1024 * 1024;
export function textureSize(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24)
    return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 0xff && bytes[1] === 0xd8)
    // JPEG: walk the markers to the first start-of-frame.
    for (let p = 2; p + 9 < bytes.length && bytes[p] === 0xff;) {
      // Fill bytes (FF FF ...) may pad a marker.
      if (bytes[p + 1] === 0xff) {
        p++;
        continue;
      }
      const marker = bytes[p + 1]!,
        length = view.getUint16(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return [view.getUint16(p + 7), view.getUint16(p + 5)];
      p += 2 + length;
    }
  return undefined;
}
export function decodeTexture(bytes: Uint8Array): Texture {
  const size = textureSize(bytes);
  if (size && size[0] * size[1] > MAX_TEXTURE_PIXELS)
    throw new ModelLoadError(
      `texture is ${size[0]} x ${size[1]} pixels; the limit is ${MAX_TEXTURE_PIXELS} pixels`,
    );
  // The decoders are given the same ceiling, so a header the sniff could not
  // read cannot fall through to their larger defaults.
  const png =
    bytes[0] === 0xff && bytes[1] === 0xd8
      ? jpeg.decode(bytes, {
          useTArray: true,
          maxResolutionInMP: MAX_TEXTURE_PIXELS / 1e6,
          maxMemoryUsageInMB: (MAX_TEXTURE_PIXELS * 4) / 2 ** 20 + 64,
        })
      : PNG.sync.read(Buffer.from(bytes));
  if (png.width * png.height > MAX_TEXTURE_PIXELS)
    throw new ModelLoadError(`texture is ${png.width} x ${png.height} pixels; too large`);
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
                    await read(companionPath(path, decodeURIComponent(item.uri))),
                  );
              return io.readJSON({ json, resources });
            })();
      // Only what the default scene shows; a GLB can carry other scenes or
      // staging nodes that are not part of the Model.
      // One decode per image however many primitives share it.
      const decoded = new Map<object, Texture>();
      const decodedTexture = (key: object, image: Uint8Array): Texture => {
        let result = decoded.get(key);
        if (!result) decoded.set(key, (result = decodeTexture(image)));
        return result;
      };
      const root = document.getRoot(),
        scene = root.getDefaultScene() ?? root.listScenes()[0],
        shown = new Set<Node>();
      if (scene) scene.traverse((node) => shown.add(node));
      // A generated GLB was already turned Z-up by its upright root node
      // (generate/download.ts); only a raw glTF needs the Y-up conversion.
      const zUp = root.listNodes().some((n) => UPRIGHT_NODES.has(n.getName()));
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
          const mode = primitive.getMode();
          if (mode !== 4 && mode !== 5 && mode !== 6) continue;
          const positions = primitive.getAttribute("POSITION");
          if (!positions) continue;
          const colors = primitive.getAttribute("COLOR_0"),
            material = primitive.getMaterial(),
            // The base colour texture names its UV set; default set 0.
            uv = primitive.getAttribute(
              `TEXCOORD_${material?.getBaseColorTextureInfo()?.getTexCoord() ?? 0}`,
            );
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
          const raw = indices
            ? Array.from({ length: indices.getCount() }, (_, i) => indices.getScalar(i))
            : Array.from({ length: positions.getCount() }, (_, i) => i);
          // Strips and fans unroll to a triangle per index past the first two.
          const ids: number[] = [];
          if (mode === 4) ids.push(...raw.slice(0, raw.length - (raw.length % 3)));
          else
            for (let i = 2; i < raw.length; i++)
              ids.push(
                mode === 6 ? raw[0]! : raw[i - 2 + (i % 2)]!,
                mode === 6 ? raw[i - 1]! : raw[i - 1 - (i % 2)]!,
                raw[i]!,
              );
          for (let i = 0; i + 2 < ids.length; i += 3) {
            const face: Face = [ids[i]! + offset, ids[i + 1]! + offset, ids[i + 2]! + offset];
            model.faces.push(determinant < 0 ? [face[2], face[1], face[0]] : face);
          }
          const texture = material?.getBaseColorTexture(),
            image = texture?.getImage(),
            factor = material?.getBaseColorFactor() ?? [1, 1, 1, 1];
          if (image && !uv)
            model.warnings.push(
              `${mesh.getName()}: has a texture but no texture coordinates; using the material colour`,
            );
          model.parts.push({
            start,
            end: model.faces.length,
            ...(image && uv && texture ? { texture: decodedTexture(texture, image) } : {}),
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
// MTL map options take up to this many values (-o/-s/-t accept one to three
// numbers); what follows them is the file.
const MAP_OPTION_VALUES: Record<string, number> = {
  "-blendu": 1,
  "-boost": 1,
  "-blendv": 1,
  "-cc": 1,
  "-clamp": 1,
  "-texres": 1,
  "-imfchan": 1,
  "-bm": 1,
  "-mm": 2,
  "-o": 3,
  "-s": 3,
  "-t": 3,
};
function textureFile(args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const option = args[i]!,
      values = MAP_OPTION_VALUES[option];
    if (values === undefined) break;
    i++;
    if (["-o", "-s", "-t"].includes(option))
      while (i < args.length && /^-?\d*\.?\d+$/.test(args[i]!)) i++;
    else i += values;
  }
  return args.slice(i).join(" ");
}
async function loadObj(path: string, read: ReadFile, model: ColouredModel) {
  const text = Buffer.from(await read(path)).toString(),
    positions: Vec3[] = [],
    uvs: [number, number][] = [],
    colours: Vec4[] = [];
  // Textures are decoded only for materials that faces use, so an unused
  // entry in a shared library cannot fail the Model.
  const materials = new Map<string, { factor: Vec4; texturePath?: string; texture?: Texture }>();
  model.turned = true;
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...words] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (kind === "mtllib") {
      for (const file of words) {
        const materialPath = companionPath(path, file);
        const mtl = Buffer.from(await read(materialPath)).toString();
        let current: { factor: Vec4; texturePath?: string; texture?: Texture } | undefined;
        for (const row of mtl.split(/\r?\n/)) {
          const [key, ...args] = row.replace(/#.*/, "").trim().split(/\s+/);
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
            current.texturePath = companionPath(path, textureFile(args), materialPath);
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
    const [kind, ...words] = line.replace(/#.*/, "").trim().split(/\s+/);
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
    if (material?.texturePath && !material.texture && hasUv)
      material.texture = decodeTexture(await read(material.texturePath));
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
