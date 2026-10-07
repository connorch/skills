import { describe, expect, it } from "vite-plus/test";
import { strToU8, zipSync } from "fflate";
import { bounds, signedVolume } from "./geometry.ts";
import { derivedPath, load, loadOBJ, loadSTL, readGltf, save } from "./load.ts";
import { box } from "./test-shapes.ts";
import { memoryIO } from "./test-io.ts";
describe("Model file formats", () => {
  it.each(["stl", "obj", "glb", "3mf"])("round-trips geometry as %s", async (format) => {
    const { io } = memoryIO(),
      path = `/cube.${format}`;
    save(path, box(10, 20, 30), io);
    const model = await load(path, io);
    expect(bounds(model).extents).toEqual([10, 20, 30]);
    expect(signedVolume(model)).toBeCloseTo(6000);
    expect(model.source.format).toBe(format);
    expect(model.unit).toBe(format === "3mf" ? "millimeter" : undefined);
  });
  it("loads ASCII STL and welds its shared corners", () => {
    const stl =
      "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle";
    expect(loadSTL(strToU8(stl)).indices.length).toBe(3);
  });
  it("triangulates OBJ polygons and relative face indices", () => {
    const mesh = loadOBJ("v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nf -4/1 -3/2 -2/3 -1/4");
    expect(mesh.indices.length).toBe(6);
    expect(bounds(mesh).extents).toEqual([10, 10, 0]);
  });
  it("merges nested 3MF components and build instances with transforms", async () => {
    const { io, files } = memoryIO();
    files.set(
      "/instances.3mf",
      zipSync({
        "3D/3dmodel.model": strToU8(
          '<model unit="inch"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object><object id="2"><components><component objectid="1" transform="2 0 0 0 2 0 0 0 2 5 0 0"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 3 0"/><item objectid="1"/></build></model>',
        ),
      }),
    );
    const mesh = await load("/instances.3mf", io);
    expect(mesh.unit).toBe("inch");
    expect(mesh.indices.length).toBe(6);
    expect(bounds(mesh).extents).toEqual([7, 5, 0]);
  });
  it("follows production-extension p:path references to object files", async () => {
    const { io, files } = memoryIO();
    files.set(
      "/project.3mf",
      zipSync({
        "3D/3dmodel.model": strToU8(
          '<model unit="millimeter"><resources><object id="2"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>',
        ),
        "3D/Objects/object_1.model": strToU8(
          '<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="3" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>',
        ),
      }),
    );
    const mesh = await load("/project.3mf", io);
    expect(mesh.indices.length).toBe(3);
    expect(bounds(mesh).min).toEqual([128, 128, 0]);
    expect(bounds(mesh).extents).toEqual([2, 3, 0]);
  });
  it("rejects compressed glTF instead of reading empty geometry", async () => {
    const { io, files } = memoryIO();
    files.set(
      "/packed.gltf",
      strToU8(
        JSON.stringify({
          asset: { version: "2.0" },
          extensionsRequired: ["KHR_draco_mesh_compression"],
        }),
      ),
    );
    await expect(load("/packed.gltf", io)).rejects.toThrow(/KHR_draco_mesh_compression/);
  });
  it("rejects cyclic components and corrupt or empty Models", async () => {
    const { io, files } = memoryIO();
    files.set(
      "/cycle.3mf",
      zipSync({
        "3D/3dmodel.model": strToU8(
          '<model><resources><object id="1"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>',
        ),
      }),
    );
    await expect(load("/cycle.3mf", io)).rejects.toThrow("cyclic");
    files.set("/bad.stl", strToU8("not a mesh"));
    await expect(load("/bad.stl", io)).rejects.toThrow();
    expect(() => loadOBJ("v 0 0 0")).toThrow();
  });
  it("applies glTF node hierarchy, quaternion, scale and interleaved accessors", async () => {
    const { io, files } = memoryIO(),
      bytes = new Uint8Array(48),
      view = new DataView(bytes.buffer);
    [0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99].forEach((v, i) => view.setFloat32(i * 4, v, true));
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 48, uri: "mesh.bin" }],
      bufferViews: [{ buffer: 0, byteLength: 48, byteStride: 16 }],
      accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
      nodes: [
        { translation: [10, 0, 0], children: [1] },
        {
          mesh: 0,
          translation: [0, 5, 0],
          scale: [2, 2, 2],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        },
      ],
      scenes: [{ nodes: [0] }],
    };
    files.set("/model.gltf", strToU8(JSON.stringify(doc)));
    files.set("/mesh.bin", bytes);
    const model = await load("/model.gltf", io);
    expect(model.indices.length).toBe(6);
    expect(bounds(model).min).toEqual([8, 5, 0]);
    expect(bounds(model).max).toEqual([10, 7, 0]);
    doc.buffers[0]!.uri =
      "data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64");
    files.set("/model.gltf", strToU8(JSON.stringify(doc)));
    expect(bounds(await load("/model.gltf", io)).extents).toEqual([2, 2, 0]);
    // Points and lines beside the surface are ignored, not an error.
    doc.meshes[0]!.primitives.push({ attributes: { POSITION: 0 }, mode: 1 } as never);
    files.set("/model.gltf", strToU8(JSON.stringify(doc)));
    expect((await load("/model.gltf", io)).indices.length).toBe(6);
  });
  it("chains derived names and falls back to STL for other extensions", () => {
    expect(derivedPath("/a/cup_scaled.glb", "_oriented")).toBe("/a/cup_scaled_oriented.glb");
    expect(derivedPath("/a/part.ply", "_scaled")).toBe("/a/part_scaled.stl");
  });
});
describe("glTF declarations", () => {
  it("reads quantized positions, refuses oversized accessors up front, and honours an empty scene", async () => {
    const { io, files } = memoryIO(),
      bytes = new Uint8Array(24),
      view = new DataView(bytes.buffer);
    // Three SHORT vertices, normalized: (0,0,0), (1,0,0), (0,1,0) in [-1, 1].
    [0, 0, 0, 0, 32767, 0, 0, 0, 0, 32767, 0, 0].forEach((v, i) => view.setInt16(i * 2, v, true));
    const uri = "data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64");
    const doc = {
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_mesh_quantization"],
      extensionsUsed: ["KHR_mesh_quantization"],
      buffers: [{ byteLength: 24, uri }],
      bufferViews: [{ buffer: 0, byteLength: 24, byteStride: 8 }],
      accessors: [{ bufferView: 0, componentType: 5122, normalized: true, type: "VEC3", count: 3 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    };
    files.set("/q.gltf", strToU8(JSON.stringify(doc)));
    expect(bounds(await load("/q.gltf", io)).extents.map((n) => Math.round(n))).toEqual([1, 1, 0]);
    files.set(
      "/big.gltf",
      strToU8(
        JSON.stringify({
          ...doc,
          // Each alone is 120 MB; together they would be 1.2 GB of zero-filled arrays.
          accessors: Array.from({ length: 10 }, () => ({ ...doc.accessors[0], count: 20_000_000 })),
        }),
      ),
    );
    await expect(load("/big.gltf", io)).rejects.toThrow("the limit is");
    files.set(
      "/negative.gltf",
      strToU8(
        JSON.stringify({
          ...doc,
          accessors: [
            { ...doc.accessors[0], count: 20_000_000 },
            { ...doc.accessors[0], count: -20_000_000 },
          ],
        }),
      ),
    );
    await expect(load("/negative.gltf", io)).rejects.toThrow("invalid count");
    files.set("/empty.gltf", strToU8(JSON.stringify({ ...doc, scenes: [{ nodes: [] }] })));
    await expect(load("/empty.gltf", io)).rejects.toThrow("no triangles");
  });
});
describe("sparse glTF accessors", () => {
  it("patches sparse POSITION values without a base buffer view", async () => {
    const bytes = new Uint8Array(28),
      view = new DataView(bytes.buffer);
    bytes.set([1, 2]);
    [1, 0, 0, 0, 1, 0].forEach((v, i) => view.setFloat32(4 + i * 4, v, true));
    const { io, files } = memoryIO();
    const doc = {
      asset: { version: "2.0" },
      buffers: [
        {
          byteLength: 28,
          uri: "data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64"),
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 2 },
        { buffer: 0, byteOffset: 4, byteLength: 24 },
      ],
      accessors: [
        {
          componentType: 5126,
          count: 3,
          type: "VEC3",
          sparse: {
            count: 2,
            indices: { bufferView: 0, componentType: 5121 },
            values: { bufferView: 1 },
          },
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    };
    files.set("/sparse.gltf", strToU8(JSON.stringify(doc)));
    expect(bounds(await load("/sparse.gltf", io)).extents).toEqual([1, 1, 0]);
  });
});
it("reads geometry without the images a glTF names, which only colour reads want", async () => {
  const { io, files } = memoryIO(),
    positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const doc = {
    asset: { version: "2.0" },
    buffers: [
      {
        byteLength: 36,
        uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString("base64")}`,
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    images: [{ uri: "missing.png" }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  files.set("/textured.gltf", strToU8(JSON.stringify(doc)));
  expect((await load("/textured.gltf", io)).indices.length).toBe(3);
  await expect(readGltf("/textured.gltf", (p) => io.read(p), { images: true })).rejects.toThrow();
});
