import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { z } from "zod";
import {
  identity,
  matrixMultiply,
  merge,
  transform,
  triangle,
  faceGeometry,
  bounds,
  weld,
} from "./geometry.ts";
import type { Mesh } from "./geometry.ts";

import { loadPLY } from "./ply.ts";

export class MeshLoadError extends Error {}
export class MeshSaveError extends Error {}
export interface MeshIO {
  read(path: string): Uint8Array;
  write(path: string, data: Uint8Array): void;
}
export const fileIO: MeshIO = {
  read: (path) => readFileSync(path),
  write: (path, data) => writeFileSync(path, data),
};
function model(positions: number[], indices: number[], format: string): Mesh {
  if (
    !indices.length ||
    indices.length % 3 ||
    positions.some((p) => !Number.isFinite(p)) ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i * 3 >= positions.length)
  )
    throw new MeshLoadError("invalid or empty triangle mesh");
  return weld({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    source: { format },
  });
}
export function loadSTL(bytes: Uint8Array): Mesh {
  const positions: number[] = [],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84 && 84 + view.getUint32(80, true) * 50 === bytes.length) {
    for (let f = 0; f < view.getUint32(80, true); f++)
      for (let k = 0; k < 9; k++) positions.push(view.getFloat32(84 + f * 50 + 12 + k * 4, true));
  } else {
    const text = strFromU8(bytes);
    if (!/^\s*solid\b/i.test(text) || !/endsolid/i.test(text))
      throw new MeshLoadError("invalid STL");
    for (const match of text.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi))
      positions.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return model(
    positions,
    Array.from({ length: positions.length / 3 }, (_, i) => i),
    "stl",
  );
}
export function loadOBJ(text: string): Mesh {
  const positions: number[] = [],
    indices: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [tag, ...values] = line.split("#")[0]!.trim().split(/\s+/);
    if (tag === "v") positions.push(...values.slice(0, 3).map(Number));
    if (tag === "f") {
      const face = values.map((v) => {
        const i = Number(v.split("/")[0]);
        return i < 0 ? positions.length / 3 + i : i - 1;
      });
      for (let j = 1; j < face.length - 1; j++) indices.push(face[0]!, face[j]!, face[j + 1]!);
    }
  }
  return model(positions, indices, "obj");
}
interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
}
// 3MF only needs element names and attributes; no entities or executable XML features.
function xmlElements(text: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new MeshLoadError("unsupported XML declaration");
  const root: Element = { name: "root", attrs: {}, children: [] },
    stack = [root];
  for (const match of text.matchAll(/<!--[^]*?-->|<\?[^]*?\?>|<([^>]+)>/g)) {
    const tag = match[1];
    if (!tag) continue;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().split(":").at(-1);
      if (stack.pop()?.name !== name || !stack.length)
        throw new MeshLoadError("invalid XML nesting");
      continue;
    }
    const name = tag.split(/[\s/]/)[0]!.split(":").at(-1)!,
      attrs: Record<string, string> = {};
    for (const attribute of tag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g))
      attrs[attribute[1]!] = attribute[3]!;
    const element = { name, attrs, children: [] };
    stack.at(-1)!.children.push(element);
    if (!tag.endsWith("/")) stack.push(element);
  }
  if (stack.length !== 1) throw new MeshLoadError("unclosed XML element");
  return root;
}
function children(element: Element | undefined, name: string): Element[] {
  return element?.children.filter((e) => e.name === name) ?? [];
}
function mfTransform(text?: string): number[] {
  if (!text) return identity;
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x)))
    throw new MeshLoadError("invalid 3MF transform");
  return [
    v[0]!,
    v[1]!,
    v[2]!,
    0,
    v[3]!,
    v[4]!,
    v[5]!,
    0,
    v[6]!,
    v[7]!,
    v[8]!,
    0,
    v[9]!,
    v[10]!,
    v[11]!,
    1,
  ];
}
export function load3MF(bytes: Uint8Array): Mesh {
  const archive = unzipSync(bytes);
  // Objects by "<model file>#<id>": the production extension (Bambu Studio
  // projects) keeps each object in its own file under 3D/Objects, referenced
  // from a component's p:path.
  const roots = new Map<string, Element>(),
    objects = new Map<string, Element>();
  function modelFile(path: string): Element {
    const known = roots.get(path);
    if (known) return known;
    const data = archive[path.replace(/^\//, "")];
    if (!data) throw new MeshLoadError(`3MF has no ${path}`);
    const root = children(xmlElements(strFromU8(data)), "model")[0];
    if (!root) throw new MeshLoadError(`${path} has no model`);
    roots.set(path, root);
    for (const o of children(children(root, "resources")[0], "object"))
      objects.set(`${path}#${o.attrs.id!}`, o);
    return root;
  }
  const root = modelFile("/3D/3dmodel.model");
  function object(path: string, id: string, ancestors: Set<string>): Mesh {
    const key = `${path}#${id}`;
    if (ancestors.has(key)) throw new MeshLoadError("cyclic 3MF components");
    modelFile(path);
    const resource = objects.get(key);
    if (!resource) throw new MeshLoadError(`missing 3MF object ${id}`);
    const ancestry = new Set([...ancestors, key]),
      mesh = children(resource, "mesh")[0];
    if (mesh) {
      const vertices = children(children(mesh, "vertices")[0], "vertex"),
        faces = children(children(mesh, "triangles")[0], "triangle");
      return model(
        vertices.flatMap((v) => ["x", "y", "z"].map((k) => Number(v.attrs[k]))),
        faces.flatMap((f) => ["v1", "v2", "v3"].map((k) => Number(f.attrs[k]))),
        "3mf",
      );
    }
    return merge(
      children(children(resource, "components")[0], "component").map((c) =>
        transform(
          object(c.attrs["p:path"] ?? path, c.attrs.objectid!, ancestry),
          mfTransform(c.attrs.transform),
        ),
      ),
      "3mf",
    );
  }
  const items = children(children(root, "build")[0], "item");
  const mesh = merge(
    items.length
      ? items.map((i) =>
          transform(
            object(i.attrs["p:path"] ?? "/3D/3dmodel.model", i.attrs.objectid!, new Set()),
            mfTransform(i.attrs.transform),
          ),
        )
      : [...objects.keys()].map((key) => {
          const [path, id] = key.split("#") as [string, string];
          return object(path, id, new Set());
        }),
    "3mf",
  );
  mesh.unit = root.attrs.unit ?? "millimeter";
  return mesh;
}
const gltfSchema = z.object({
  buffers: z.array(z.object({ uri: z.string().optional(), byteLength: z.number() })).default([]),
  bufferViews: z
    .array(
      z.object({
        buffer: z.number(),
        byteOffset: z.number().default(0),
        byteLength: z.number(),
        byteStride: z.number().optional(),
      }),
    )
    .default([]),
  accessors: z
    .array(
      z.object({
        bufferView: z.number().optional(),
        byteOffset: z.number().default(0),
        componentType: z.number(),
        count: z.number(),
        type: z.string(),
        normalized: z.boolean().default(false),
        sparse: z
          .object({
            count: z.number().int().nonnegative(),
            indices: z.object({
              bufferView: z.number().int().nonnegative(),
              byteOffset: z.number().int().nonnegative().default(0),
              componentType: z.number(),
            }),
            values: z.object({
              bufferView: z.number().int().nonnegative(),
              byteOffset: z.number().int().nonnegative().default(0),
            }),
          })
          .optional(),
      }),
    )
    .default([]),
  meshes: z
    .array(
      z.object({
        primitives: z.array(
          z.object({
            attributes: z.object({ POSITION: z.number().optional() }),
            indices: z.number().optional(),
            mode: z.number().default(4),
          }),
        ),
      }),
    )
    .default([]),
  nodes: z
    .array(
      z.object({
        mesh: z.number().optional(),
        children: z.array(z.number()).default([]),
        matrix: z.array(z.number()).length(16).optional(),
        translation: z.array(z.number()).length(3).optional(),
        rotation: z.array(z.number()).length(4).optional(),
        scale: z.array(z.number()).length(3).optional(),
      }),
    )
    .default([]),
  scenes: z.array(z.object({ nodes: z.array(z.number()).default([]) })).default([]),
  scene: z.number().optional(),
});
export function loadGLTF(json: unknown, buffers: Uint8Array[], format = "gltf"): Mesh {
  const doc = gltfSchema.parse(json);
  function values(
    bufferView: number,
    offset: number,
    type: number,
    count: number,
    components: number,
  ): number[] {
    const b = doc.bufferViews[bufferView],
      bytes = b && buffers[b.buffer];
    if (!b || !bytes) throw new MeshLoadError("missing glTF buffer");
    const size =
      type === 5126 || type === 5125
        ? 4
        : type === 5123 || type === 5122
          ? 2
          : type === 5121 || type === 5120
            ? 1
            : 0;
    if (!size) throw new MeshLoadError("unsupported glTF component type");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      result: number[] = [];
    for (let i = 0; i < count; i++)
      for (let c = 0; c < components; c++) {
        const p = b.byteOffset + offset + i * (b.byteStride ?? components * size) + c * size;
        if (p + size > b.byteOffset + b.byteLength)
          throw new MeshLoadError("glTF accessor exceeds buffer view");
        result.push(
          type === 5126
            ? view.getFloat32(p, true)
            : type === 5125
              ? view.getUint32(p, true)
              : type === 5123
                ? view.getUint16(p, true)
                : type === 5122
                  ? view.getInt16(p, true)
                  : type === 5121
                    ? view.getUint8(p)
                    : view.getInt8(p),
        );
      }
    return result;
  }
  function accessor(index: number, components: number): number[] {
    const a = doc.accessors[index];
    if (!a) throw new MeshLoadError("missing glTF accessor");
    if (a.type !== (components === 3 ? "VEC3" : "SCALAR"))
      throw new MeshLoadError("unexpected glTF accessor type");
    const result =
      a.bufferView === undefined
        ? Array<number>(a.count * components).fill(0)
        : values(a.bufferView, a.byteOffset, a.componentType, a.count, components);
    if (a.sparse) {
      const sparse = a.sparse,
        indices = values(
          sparse.indices.bufferView,
          sparse.indices.byteOffset,
          sparse.indices.componentType,
          sparse.count,
          1,
        ),
        overrides = values(
          sparse.values.bufferView,
          sparse.values.byteOffset,
          a.componentType,
          sparse.count,
          components,
        );
      for (let i = 0; i < sparse.count; i++) {
        const target = indices[i]!;
        if (!Number.isInteger(target) || target < 0 || target >= a.count)
          throw new MeshLoadError("invalid sparse glTF index");
        for (let c = 0; c < components; c++)
          result[target * components + c] = overrides[i * components + c]!;
      }
    }
    if (a.normalized && a.componentType !== 5126) {
      const max =
        a.componentType === 5120
          ? 127
          : a.componentType === 5121
            ? 255
            : a.componentType === 5122
              ? 32767
              : a.componentType === 5123
                ? 65535
                : 4294967295;
      return result.map((v) => Math.max(-1, v / max));
    }
    return result;
  }
  const meshes = doc.meshes.map((m) =>
    merge(
      m.primitives
        .filter((p) => p.attributes.POSITION !== undefined)
        .map((p) => {
          const positions = accessor(p.attributes.POSITION!, 3),
            raw =
              p.indices === undefined
                ? Array.from({ length: positions.length / 3 }, (_, i) => i)
                : accessor(p.indices, 1),
            indices: number[] = [];
          if (p.mode === 4) for (const i of raw) indices.push(i);
          else if (p.mode === 5 || p.mode === 6)
            for (let i = 2; i < raw.length; i++)
              indices.push(
                p.mode === 6 ? raw[0]! : raw[i - 2 + (i % 2)]!,
                p.mode === 6 ? raw[i - 1]! : raw[i - 1 - (i % 2)]!,
                raw[i]!,
              );
          else throw new MeshLoadError("glTF primitive is not triangles");
          return model(positions, indices, format);
        }),
      format,
    ),
  );
  const instances: Mesh[] = [];
  function visit(index: number, parent: readonly number[], ancestors: Set<number>) {
    const n = doc.nodes[index];
    if (!n || ancestors.has(index)) throw new MeshLoadError("invalid glTF node graph");
    let local = n.matrix;
    if (!local) {
      const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1],
        s = n.scale ?? [1, 1, 1],
        t = n.translation ?? [0, 0, 0];
      local = [
        (1 - 2 * (y! * y! + z! * z!)) * s[0]!,
        2 * (x! * y! + z! * w!) * s[0]!,
        2 * (x! * z! - y! * w!) * s[0]!,
        0,
        2 * (x! * y! - z! * w!) * s[1]!,
        (1 - 2 * (x! * x! + z! * z!)) * s[1]!,
        2 * (y! * z! + x! * w!) * s[1]!,
        0,
        2 * (x! * z! + y! * w!) * s[2]!,
        2 * (y! * z! - x! * w!) * s[2]!,
        (1 - 2 * (x! * x! + y! * y!)) * s[2]!,
        0,
        t[0]!,
        t[1]!,
        t[2]!,
        1,
      ];
    }
    const world = matrixMultiply(parent, local);
    if (n.mesh !== undefined) {
      const m = meshes[n.mesh];
      if (!m) throw new MeshLoadError("missing glTF mesh");
      instances.push(transform(m, world));
    }
    for (const child of n.children) visit(child, world, new Set([...ancestors, index]));
  }
  const roots =
    doc.scenes[doc.scene ?? 0]?.nodes ??
    doc.nodes.map((_, i) => i).filter((i) => !doc.nodes.some((n) => n.children.includes(i)));
  for (const root of roots) visit(root, identity, new Set());
  return merge(doc.nodes.length ? instances : meshes, format);
}
// Loaders read only local files or embedded buffers; no network requests.
export function load(path: string, io: MeshIO = fileIO): Mesh {
  try {
    const bytes = io.read(path),
      format = extname(path).slice(1).toLowerCase();
    let mesh: Mesh;
    if (format === "stl") mesh = loadSTL(bytes);
    else if (format === "obj") mesh = loadOBJ(strFromU8(bytes));
    else if (format === "3mf") mesh = load3MF(bytes);
    else if (format === "ply") mesh = loadPLY(bytes);
    else if (format === "glb" || format === "gltf") {
      let json: unknown, bin: Uint8Array | undefined;
      if (format === "glb") {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (
          view.getUint32(0, true) !== 0x46546c67 ||
          view.getUint32(4, true) !== 2 ||
          view.getUint32(8, true) !== bytes.length
        )
          throw new MeshLoadError("invalid GLB header");
        for (let p = 12; p < bytes.length;) {
          const length = view.getUint32(p, true),
            type = view.getUint32(p + 4, true);
          if (p + 8 + length > bytes.length) throw new MeshLoadError("truncated GLB");
          const chunk = bytes.subarray(p + 8, p + 8 + length);
          if (type === 0x4e4f534a) json = JSON.parse(strFromU8(chunk));
          if (type === 0x004e4942) bin = chunk;
          p += 8 + length;
        }
      } else json = JSON.parse(strFromU8(bytes));
      const doc = gltfSchema.parse(json),
        buffers = doc.buffers.map((b) => {
          if (!b.uri) {
            if (!bin) throw new MeshLoadError("missing GLB BIN chunk");
            return bin;
          }
          if (b.uri.startsWith("data:"))
            return new Uint8Array(Buffer.from(b.uri.slice(b.uri.indexOf(",") + 1), "base64"));
          if (/^[a-z]+:/i.test(b.uri))
            throw new MeshLoadError("remote glTF buffers are unsupported");
          return io.read(join(dirname(path), decodeURIComponent(b.uri)));
        });
      mesh = loadGLTF(json, buffers, format);
    } else throw new MeshLoadError(`unsupported format: ${format}`);
    if (!mesh.indices.length) throw new MeshLoadError(`${basename(path)} contains no triangles`);
    return mesh;
  } catch (error) {
    throw new MeshLoadError(
      `could not read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export function derivedPath(source: string, suffix: string): string {
  const ext = extname(source);
  return join(
    dirname(source),
    `${basename(source, ext)}${suffix}${[".stl", ".obj", ".glb", ".3mf"].includes(ext.toLowerCase()) ? ext : ".stl"}`,
  );
}
export function encodeSTL(mesh: Mesh): Uint8Array {
  const bytes = new Uint8Array(84 + (mesh.indices.length / 3) * 50),
    view = new DataView(bytes.buffer),
    { normals } = faceGeometry(mesh);
  view.setUint32(80, mesh.indices.length / 3, true);
  for (let f = 0; f < normals.length; f++) {
    const values = [...normals[f]!, ...triangle(mesh, f).flat()];
    for (let k = 0; k < 12; k++) view.setFloat32(84 + f * 50 + k * 4, values[k]!, true);
  }
  return bytes;
}
// Derived files retain supported input formats, with geometry only.
export function save(path: string, mesh: Mesh, io: MeshIO = fileIO): void {
  try {
    const format = extname(path).toLowerCase();
    let bytes: Uint8Array;
    if (format === ".stl") bytes = encodeSTL(mesh);
    else if (format === ".obj") {
      const lines: string[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3)
        lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
      for (let f = 0; f < mesh.indices.length; f += 3)
        lines.push(
          `f ${mesh.indices[f]! + 1} ${mesh.indices[f + 1]! + 1} ${mesh.indices[f + 2]! + 1}`,
        );
      bytes = strToU8(lines.join("\n") + "\n");
    } else if (format === ".3mf") {
      const vertices: string[] = [],
        faces: string[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3)
        vertices.push(
          `<vertex x="${mesh.positions[i]}" y="${mesh.positions[i + 1]}" z="${mesh.positions[i + 2]}"/>`,
        );
      for (let f = 0; f < mesh.indices.length; f += 3)
        faces.push(
          `<triangle v1="${mesh.indices[f]}" v2="${mesh.indices[f + 1]}" v3="${mesh.indices[f + 2]}"/>`,
        );
      bytes = zipSync({
        "3D/3dmodel.model": strToU8(
          `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.join("")}</vertices><triangles>${faces.join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
        ),
        "[Content_Types].xml": strToU8(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>',
        ),
      });
    } else if (format === ".glb") {
      const positions = new Uint8Array(mesh.positions.length * 4),
        indices = new Uint8Array(mesh.indices.length * 4),
        pv = new DataView(positions.buffer),
        iv = new DataView(indices.buffer);
      mesh.positions.forEach((v, i) => pv.setFloat32(i * 4, v, true));
      mesh.indices.forEach((v, i) => iv.setUint32(i * 4, v, true));
      const doc = {
        asset: { version: "2.0" },
        buffers: [{ byteLength: positions.length + indices.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: positions.length },
          { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
        ],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: mesh.positions.length / 3,
            type: "VEC3",
            min: bounds(mesh).min,
            max: bounds(mesh).max,
          },
          { bufferView: 1, componentType: 5125, count: mesh.indices.length, type: "SCALAR" },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      };
      const json = strToU8(JSON.stringify(doc)),
        padded = Math.ceil(json.length / 4) * 4;
      bytes = new Uint8Array(28 + padded + positions.length + indices.length);
      const v = new DataView(bytes.buffer);
      v.setUint32(0, 0x46546c67, true);
      v.setUint32(4, 2, true);
      v.setUint32(8, bytes.length, true);
      v.setUint32(12, padded, true);
      v.setUint32(16, 0x4e4f534a, true);
      bytes.fill(32, 20, 20 + padded);
      bytes.set(json, 20);
      v.setUint32(20 + padded, positions.length + indices.length, true);
      v.setUint32(24 + padded, 0x004e4942, true);
      bytes.set(positions, 28 + padded);
      bytes.set(indices, 28 + padded + positions.length);
    } else throw new MeshSaveError(`unsupported output format: ${format}`);
    io.write(path, bytes);
  } catch (error) {
    throw new MeshSaveError(
      `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
