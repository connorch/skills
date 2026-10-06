// Turn the embedded GLB into one geometry resting on the plate, plus the
// numbers the page shows. Model space is Z-up like the printer; the scene
// rotates it to three.js's Y-up once, in <Stage>.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export interface LoadedModel {
  geometry: THREE.BufferGeometry;
  size: THREE.Vector3;
  // Half the bounding-box diagonal: the camera distance scale.
  radius: number;
  painted: boolean;
}

export async function loadModel(glbBase64: string): Promise<LoadedModel> {
  const bytes = Uint8Array.from(atob(glbBase64), (c) => c.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
  gltf.scene.updateMatrixWorld(true);

  const parts: THREE.BufferGeometry[] = [];
  let painted = false;
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = (object.geometry as THREE.BufferGeometry)
      .clone()
      .applyMatrix4(object.matrixWorld);
    // Keep only what rendering needs so every part merges cleanly.
    for (const name of Object.keys(geometry.attributes)) {
      if (!["position", "normal", "color"].includes(name)) geometry.deleteAttribute(name);
    }
    if (geometry.index) parts.push(geometry.toNonIndexed());
    else parts.push(geometry);
    if (geometry.hasAttribute("color")) painted = true;
  });
  if (parts.length === 0) throw new Error("the model has no meshes");
  // A part without vertex colours would block the merge; give it white.
  if (painted) {
    for (const part of parts) {
      if (!part.hasAttribute("color")) {
        const n = part.getAttribute("position").count;
        part.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      }
    }
  }
  const geometry = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
  if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  // Centre on the origin and rest on the plate (Z-up model space).
  geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z);
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox!.getSize(size);
  return { geometry, size, radius: size.length() / 2, painted };
}
