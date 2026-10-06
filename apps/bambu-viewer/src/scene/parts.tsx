// Scene pieces shared by the main view and the view tiles.

import { useMemo } from "react";
import * as THREE from "three";
import type { LoadedModel } from "../model.ts";

// Key light from high and to the side so the shadow falls beside the Model,
// plus a cool rim from behind so dark filaments keep an outline.
export function Lights({ radius }: { radius: number }) {
  const r = radius;
  return (
    <>
      <directionalLight
        position={[r * 2.6, r * 3.4, r * 1.4]}
        intensity={1.25}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-r * 2}
        shadow-camera-right={r * 2}
        shadow-camera-top={r * 2}
        shadow-camera-bottom={-r * 2}
        shadow-camera-near={0.1}
        shadow-camera-far={r * 12}
      />
      <directionalLight position={[-r * 2.5, r * 1.2, -r * 2]} intensity={0.7} color="#c4d4ff" />
    </>
  );
}

// The Model, rotated from its Z-up space to the scene's Y-up. Painted Models
// keep their vertex colours; everything else gets the filament colour.
export function ModelMesh({ model, color }: { model: LoadedModel; color: string }) {
  return (
    <group rotation-x={-Math.PI / 2}>
      <mesh geometry={model.geometry} castShadow>
        <meshStandardMaterial
          color={model.painted ? "#ffffff" : color}
          vertexColors={model.painted}
          roughness={0.6}
          metalness={0}
        />
      </mesh>
    </group>
  );
}

// The build plate: a 10 mm grid with 50 mm majors and a thicker edge, fading
// out from the centre so the plate reads as scale without a hard frame, plus
// a shadow catcher.
export function Plate({ size }: { size: [number, number, number] }) {
  const [w, d] = size;
  const texture = useMemo(() => plateTexture(w, d), [w, d]);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[w, d]} />
        <shadowMaterial opacity={0.42} />
      </mesh>
    </>
  );
}

function plateTexture(w: number, d: number): THREE.CanvasTexture {
  const px = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const g = canvas.getContext("2d")!;
  const sx = px / w;
  const sy = px / d;
  const line = (x1: number, y1: number, x2: number, y2: number, major: boolean) => {
    g.strokeStyle = major ? "rgba(255,255,255,0.11)" : "rgba(255,255,255,0.055)";
    g.lineWidth = major ? 2.5 : 2;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  for (let v = 10; v < w; v += 10) line(v * sx, 0, v * sx, px, v % 50 === 0);
  for (let v = 10; v < d; v += 10) line(0, v * sy, px, v * sy, v % 50 === 0);
  g.strokeStyle = "rgba(255,255,255,0.5)";
  g.lineWidth = 12;
  g.strokeRect(5, 5, px - 10, px - 10);
  g.globalCompositeOperation = "destination-in";
  const fade = g.createRadialGradient(px / 2, px / 2, px * 0.08, px / 2, px / 2, px * 0.78);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, px, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  return texture;
}
