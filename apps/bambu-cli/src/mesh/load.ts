import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  NodeIO,
  type Document,
  type GLTF,
  type JSONDocument,
  type Mesh as GltfMesh,
  type Node as GltfNode,
} from "@gltf-transform/core";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { identity, merge, transform, triangle, faceGeometry, bounds, weld } from "./geometry.ts";
import type { Mesh } from "./geometry.ts";

import { loadPLY } from "./ply.ts";

export class MeshLoadError extends Error {}
// A file a Model refers to (glTF buffer, MTL, texture) must sit beside it: a
// downloaded Model cannot reach outside its own folder.
// `reference` is resolved beside `from` (the MTL, say) but must stay in the
// Model's own folder.
export function companionPath(model: string, reference: string, from = model): string {
  const dir = dirname(model),
    target = resolve(dirname(from), reference);
  const outside = (from: string, to: string) => {
    const inside = relative(from, to);
    return !inside || inside.startsWith("..") || isAbsolute(inside);
  };
  // Lexically first, then by real path so a link inside the folder cannot
  // point out of it.
  let escaped = outside(dir, target);
  if (!escaped && existsSync(target))
    try {
      escaped = outside(realpathSync(dir), realpathSync(target));
    } catch {
      escaped = true;
    }
  if (escaped)
    throw new MeshLoadError(`${basename(model)} refers to ${reference}, outside its folder`);
  return target;
}
export const MAX_ACCESSOR_COUNT = 20_000_000;
const MAX_TRIANGLES = 20_000_000;
const MAX_MODEL_FILE_BYTES = 1024 * 1024 * 1024;
export class MeshSaveError extends Error {}
export interface MeshIO {
  read(path: string): Uint8Array;
  write(path: string, data: Uint8Array): void;
  exists(path: string): boolean;
}
export const fileIO: MeshIO = {
  read: (path) => readFileSync(path),
  exists: (path) => existsSync(path),
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
    if (view.getUint32(80, true) > MAX_TRIANGLES)
      throw new MeshLoadError(
        `STL has ${view.getUint32(80, true)} triangles; the limit is ${MAX_TRIANGLES}`,
      );
    for (let f = 0; f < view.getUint32(80, true); f++)
      for (let k = 0; k < 9; k++) positions.push(view.getFloat32(84 + f * 50 + 12 + k * 4, true));
  } else {
    const text = strFromU8(bytes);
    if (!/^\s*solid\b/i.test(text) || !/endsolid/i.test(text))
      throw new MeshLoadError("invalid STL");
    for (const match of text.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi)) {
      if (positions.length >= MAX_TRIANGLES * 9)
        throw new MeshLoadError(`STL has more than ${MAX_TRIANGLES} triangles`);
      positions.push(Number(match[1]), Number(match[2]), Number(match[3]));
    }
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
  // Inflate only the model files, and none past what a mesh could be, so a
  // hostile or huge archive cannot exhaust memory before it is inspected.
  let expanded = 0;
  const archive = unzipSync(bytes, {
    filter: (entry) => {
      if (!/^3D\/.*\.model$/i.test(entry.name)) return false;
      expanded += entry.originalSize ?? entry.size;
      if (expanded > MAX_MODEL_FILE_BYTES)
        throw new MeshLoadError(`the model files expand past ${MAX_MODEL_FILE_BYTES / 2 ** 30} GB`);
      return true;
    },
  });
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
// Geometry stored by these extensions is not in the accessors a reader sees.
const COMPRESSION = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);
// The one way a glTF or GLB is opened, for the analysis loader here and the
// paint loader alike: a gltf-transform Document, with companion files
// (buffers, images) read through the caller and kept to the Model's folder.
export async function readGltf(
  path: string,
  read: (path: string) => Uint8Array | Promise<Uint8Array>,
): Promise<Document> {
  const io = new NodeIO(),
    bytes = await read(path);
  let jsonDoc: JSONDocument;
  if (extname(path).toLowerCase() === ".glb")
    jsonDoc = await io.binaryToJSON(new Uint8Array(bytes));
  else {
    const json = JSON.parse(strFromU8(bytes)) as GLTF.IGLTF,
      resources: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const item of [...(json.buffers ?? []), ...(json.images ?? [])])
      if (item.uri && !item.uri.startsWith("data:")) {
        if (/^[a-z]+:/i.test(item.uri))
          throw new MeshLoadError("remote glTF buffers are unsupported");
        resources[item.uri] = new Uint8Array(
          await read(companionPath(path, decodeURIComponent(item.uri))),
        );
      }
    jsonDoc = { json, resources };
  }
  const compressed = jsonDoc.json.extensionsRequired?.find((e) => COMPRESSION.has(e));
  if (compressed)
    throw new MeshLoadError(
      `${compressed} glTF is not supported; export the Model uncompressed (or as STL or 3MF)`,
    );
  return io.readJSON(jsonDoc);
}
// The surface geometry of what the Document's default scene shows (or every
// node, or every mesh, when it has none), in world coordinates.
export function loadGLTF(document: Document, format = "gltf"): Mesh {
  const root = document.getRoot();
  // Points and lines (guides, annotations) are not surfaces; they are left out
  // rather than failing the Model. A mesh with no surface primitive is empty.
  const empty: Mesh = {
    positions: new Float32Array(),
    indices: new Uint32Array(),
    source: { format },
  };
  // Decoded on first use, so an instanced mesh is decoded once and an unused one never.
  const decoded = new Map<GltfMesh, Mesh>();
  const meshAt = (m: GltfMesh): Mesh => {
    let mesh = decoded.get(m);
    if (!mesh) decoded.set(m, (mesh = decodeMesh(m)));
    return mesh;
  };
  const decodeMesh = (m: GltfMesh): Mesh => {
    const surfaces = m
      .listPrimitives()
      .filter((p) => p.getAttribute("POSITION") && [4, 5, 6].includes(p.getMode()));
    if (!surfaces.length) return empty;
    return merge(
      surfaces.map((p) => {
        const attribute = p.getAttribute("POSITION")!,
          count = attribute.getCount();
        if (count > MAX_ACCESSOR_COUNT)
          throw new MeshLoadError(
            `glTF accessor has ${count} elements; the limit is ${MAX_ACCESSOR_COUNT}`,
          );
        // getElement decodes normalized integer positions (KHR_mesh_quantization).
        const positions: number[] = [],
          element: number[] = [];
        for (let i = 0; i < count; i++) positions.push(...attribute.getElement(i, element));
        const index = p.getIndices(),
          raw = index ? Array.from(index.getArray()!) : Array.from({ length: count }, (_, i) => i),
          indices: number[] = [],
          mode = p.getMode();
        if (mode === 4) for (const i of raw) indices.push(i);
        else
          for (let i = 2; i < raw.length; i++)
            indices.push(
              mode === 6 ? raw[0]! : raw[i - 2 + (i % 2)]!,
              mode === 6 ? raw[i - 1]! : raw[i - 1 - (i % 2)]!,
              raw[i]!,
            );
        return model(positions, indices, format);
      }),
      format,
    );
  };
  const scene = root.getDefaultScene() ?? root.listScenes()[0],
    nodes: GltfNode[] = [];
  if (scene) scene.traverse((node) => nodes.push(node));
  else nodes.push(...root.listNodes());
  const instances = nodes.flatMap((node) => {
    const m = node.getMesh();
    return m ? [transform(meshAt(m), node.getWorldMatrix())] : [];
  });
  return merge(nodes.length ? instances : root.listMeshes().map(meshAt), format);
}
// Loaders read only local files or embedded buffers; no network requests.
export async function load(path: string, io: MeshIO = fileIO): Promise<Mesh> {
  try {
    const bytes = io.read(path),
      format = extname(path).slice(1).toLowerCase();
    let mesh: Mesh;
    if (format === "stl") mesh = loadSTL(bytes);
    else if (format === "obj") mesh = loadOBJ(strFromU8(bytes));
    else if (format === "3mf") mesh = load3MF(bytes);
    else if (format === "ply") mesh = loadPLY(bytes);
    else if (format === "glb" || format === "gltf")
      mesh = loadGLTF(await readGltf(path, (p) => io.read(p)), format);
    else throw new MeshLoadError(`unsupported format: ${format}`);
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
