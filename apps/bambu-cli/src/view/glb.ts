// Pack a mesh into a GLB the Review Page can show: welded, simplified to a
// preview-sized triangle count, with vertex colours kept for painted Models.

import { Document, NodeIO } from "@gltf-transform/core";
import { simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

// Typed arrays over a plain ArrayBuffer: gltf-transform rejects SharedArrayBuffer-backed views.
export interface PreviewMesh {
  positions: Float32Array<ArrayBuffer>;
  indices?: Uint32Array<ArrayBuffer>;
  // RGB per vertex, 0-1, for painted Models.
  colors?: Float32Array<ArrayBuffer>;
}

// Above this the page gets slow to orbit on a laptop; below it the preview
// still shows every feature a print decision needs.
export const PREVIEW_TRIANGLES = 150_000;

export async function buildGlb(mesh: PreviewMesh): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType("VEC3").setArray(mesh.positions).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", position);
  if (mesh.indices) {
    prim.setIndices(
      doc.createAccessor().setType("SCALAR").setArray(mesh.indices).setBuffer(buffer),
    );
  }
  if (mesh.colors) {
    prim.setAttribute(
      "COLOR_0",
      doc.createAccessor().setType("VEC3").setArray(mesh.colors).setBuffer(buffer),
    );
  }
  const node = doc.createNode("model").setMesh(doc.createMesh("model").addPrimitive(prim));
  doc.createScene().addChild(node);

  const triangles = (mesh.indices?.length ?? mesh.positions.length / 3) / 3;
  const transforms = [weld()];
  if (triangles > PREVIEW_TRIANGLES) {
    await MeshoptSimplifier.ready;
    transforms.push(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: PREVIEW_TRIANGLES / triangles,
        error: 0.001,
      }),
    );
  }
  await doc.transform(...transforms);
  return new NodeIO().writeBinary(doc);
}
