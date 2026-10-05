// A static thumbnail of one view. Orthographic for the three projections so
// their captions' dimensions are what you see; perspective for the 3D one.

import { Canvas, useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import * as THREE from "three";
import type { LoadedModel } from "../model.ts";
import { Lights, ModelMesh } from "./parts.tsx";
import { VIEW_DIRS, type ViewName } from "./Stage.tsx";

export function Tile({
  model,
  view,
  color,
}: {
  model: LoadedModel;
  view: ViewName;
  color: string;
}) {
  const ortho = view !== "iso";
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
      orthographic={ortho}
      camera={{ near: 0.1, far: model.radius * 40, fov: 30 }}
    >
      <hemisphereLight intensity={0.9} color="#dfe6f5" groundColor="#1a1d24" />
      <Lights radius={model.radius} />
      <ModelMesh model={model} color={color} />
      <TileCamera model={model} view={view} />
    </Canvas>
  );
}

// Width and height of the Model as seen from each projection (model space).
function extents(model: LoadedModel, view: ViewName): [number, number] {
  const { x, y, z } = model.size;
  return view === "front" ? [x, z] : view === "side" ? [y, z] : [x, y];
}

function TileCamera({ model, view }: { model: LoadedModel; view: ViewName }) {
  const { get, size, invalidate } = useThree();
  useLayoutEffect(() => {
    const { camera } = get();
    const center = new THREE.Vector3(0, model.size.z / 2, 0);
    const dir = new THREE.Vector3(...VIEW_DIRS[view]).normalize();
    const aspect = size.width / Math.max(1, size.height);
    let dist: number;
    if (camera instanceof THREE.OrthographicCamera) {
      const [w, h] = extents(model, view);
      const half = Math.max(h / 2, w / 2 / aspect) * 1.3;
      camera.top = half;
      camera.bottom = -half;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      dist = model.radius * 4;
    } else {
      const cam = camera as THREE.PerspectiveCamera;
      cam.aspect = aspect;
      dist = (model.radius * 1.3) / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2);
    }
    camera.updateProjectionMatrix();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    invalidate();
  }, [get, invalidate, model, view, size.width, size.height]);
  return null;
}
