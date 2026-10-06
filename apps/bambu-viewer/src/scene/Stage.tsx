// The main 3D view: the Model on the build plate with lighting, a soft
// shadow, dimension labels, and a camera that frames the Model in whatever
// part of the viewport the overlays leave free. Renders only on demand.

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { OrbitControls as OrbitControlsImpl } from "three/addons/controls/OrbitControls.js";
import type { LoadedModel } from "../model.ts";
import { Lights, Plate, ModelMesh } from "./parts.tsx";

export type ViewName = "iso" | "front" | "side" | "top";

// Unit directions the camera looks from, in world space (Y up). Model X is
// world X, model Y is world -Z, model Z is world Y, so "front" looks along -Z.
export const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1.3, 0.95, 1.5],
  front: [0, 0, 1],
  side: [1, 0, 0],
  top: [0, 1, 0.0001],
};

// Screen space (px) covered by overlays on each edge; the Model is centred in
// what remains.
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ViewRequest {
  name: ViewName;
  // Changes on every request so re-clicking the current view still re-frames.
  nonce: number;
}

interface StageProps {
  model: LoadedModel;
  plate: [number, number, number];
  color: string;
  view: ViewRequest;
  insets: Insets;
  labels: RefObject<HTMLDivElement | null>;
  onUserOrbit: () => void;
}

export function Stage({ model, plate, color, view, insets, labels, onUserOrbit }: StageProps) {
  const center = useMemo(() => new THREE.Vector3(0, model.size.z / 2, 0), [model]);
  const far = Math.max(model.radius * 60, plate[0] * 8);
  return (
    <Canvas
      frameloop="demand"
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
      camera={{
        fov: 30,
        near: 0.1,
        far,
        position: [model.radius * 3, model.radius * 2, model.radius * 3],
      }}
    >
      <RoomLighting />
      <Lights radius={model.radius} />
      <Plate size={plate} />
      <ModelMesh model={model} color={color} />
      <BoundingBox size={model.size} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={model.radius * 1.2}
        maxDistance={Math.max(model.radius * 14, plate[0] * 3)}
        target={center}
        onStart={onUserOrbit}
      />
      <CameraRig model={model} center={center} view={view} insets={insets} />
      <DimensionLabels size={model.size} radius={model.radius} labels={labels} />
    </Canvas>
  );
}

// Image-based lighting from three's RoomEnvironment: soft reflections on the
// filament without any external HDR file.
function RoomLighting() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl, scene } = get();
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = texture;
    scene.environmentIntensity = 0.42;
    pmrem.dispose();
    return () => {
      scene.environment = null;
      texture.dispose();
    };
  }, [get]);
  return null;
}

function BoundingBox({ size }: { size: THREE.Vector3 }) {
  const helper = useMemo(() => {
    const box = new THREE.Box3(
      new THREE.Vector3(-size.x / 2, 0, -size.y / 2),
      new THREE.Vector3(size.x / 2, size.z, size.y / 2),
    );
    const h = new THREE.Box3Helper(box, 0xffffff);
    (h.material as THREE.LineBasicMaterial).transparent = true;
    (h.material as THREE.LineBasicMaterial).opacity = 0.14;
    return h;
  }, [size]);
  return <primitive object={helper} />;
}

// Frames the Model for the requested view and animates there: the orbit
// target glides back to the Model's centre (undoing any pan) while the camera
// swings round at the fitted distance (undoing any zoom).
function CameraRig({
  model,
  center,
  view,
  insets,
}: {
  model: LoadedModel;
  center: THREE.Vector3;
  view: ViewRequest;
  insets: Insets;
}) {
  const { get, size, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const anim = useRef<((now: number) => boolean) | null>(null);

  useEffect(() => {
    const camera = get().camera as THREE.PerspectiveCamera;
    // Offset the projection so the Model centres in the free area, and fit
    // the camera distance to it with some margin.
    const { width: W, height: H } = size;
    const { top: t, bottom: b, left: l, right: r } = insets;
    camera.aspect = W / H;
    camera.setViewOffset(W, H, (r - l) / 2, (b - t) / 2, W, H);
    camera.updateProjectionMatrix();
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const ht = Math.min((half * (H - t - b)) / H, (half * (W / H) * (W - l - r)) / W);
    const dist = (model.radius * 1.3) / Math.sin(Math.atan(ht));

    const to = new THREE.Vector3(...VIEW_DIRS[view.name]).normalize();
    if (!controls) {
      camera.position.copy(center).addScaledVector(to, dist);
      camera.lookAt(center);
      invalidate();
      return;
    }
    const t0 = controls.target.clone();
    const from = camera.position.clone().sub(t0);
    const d0 = from.length();
    from.normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(from, to);
    const none = new THREE.Quaternion();
    const step = new THREE.Quaternion();
    const start = performance.now();
    anim.current = (now) => {
      const k = Math.min(1, (now - start) / 450);
      const e = 1 - Math.pow(1 - k, 3);
      step.slerpQuaternions(none, turn, e);
      controls.target.lerpVectors(t0, center, e);
      camera.position
        .copy(controls.target)
        .addScaledVector(from.clone().applyQuaternion(step), d0 + (dist - d0) * e);
      camera.lookAt(controls.target);
      return k < 1;
    };
    invalidate();
    // `view` is a new object on every request, so re-clicking the current
    // view still re-frames; insets and size changes re-fit.
  }, [get, invalidate, controls, model, center, view, insets, size]);

  useFrame(() => {
    if (!anim.current) return;
    if (!anim.current(performance.now())) anim.current = null;
    invalidate();
  });
  return null;
}

// X, Y and Z size labels pinned to the bounding box. They live in a plain DOM
// layer outside the canvas (cheap to move) and hide when their axis points at
// the viewer, where they would only clutter the middle of the Model.
function DimensionLabels({
  size,
  radius,
  labels,
}: {
  size: THREE.Vector3;
  radius: number;
  labels: RefObject<HTMLDivElement | null>;
}) {
  const { camera, size: viewport } = useThree();
  const marks = useMemo(() => {
    const o = radius * 0.14;
    return [
      { axis: new THREE.Vector3(1, 0, 0), at: new THREE.Vector3(0, 0, size.y / 2 + o), key: "x" },
      { axis: new THREE.Vector3(0, 0, 1), at: new THREE.Vector3(size.x / 2 + o, 0, 0), key: "y" },
      {
        axis: new THREE.Vector3(0, 1, 0),
        at: new THREE.Vector3(size.x / 2 + o * 0.7, size.z / 2, size.y / 2 + o * 0.7),
        key: "z",
      },
    ];
  }, [size, radius]);
  const look = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const layer = labels.current;
    if (!layer) return;
    camera.getWorldDirection(look);
    for (const m of marks) {
      const el = layer.querySelector<HTMLElement>(`[data-axis="${m.key}"]`);
      if (!el) continue;
      const s = m.at.clone().project(camera);
      const x = ((s.x + 1) / 2) * viewport.width;
      const y = ((1 - s.y) / 2) * viewport.height;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      el.style.opacity = Math.abs(m.axis.dot(look)) > 0.9 ? "0" : "1";
    }
  });
  return null;
}
