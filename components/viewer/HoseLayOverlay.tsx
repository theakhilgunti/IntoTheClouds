"use client";

import { useMemo } from "react";
import { Line } from "@react-three/drei";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { HoseLay } from "@/lib/hose-lay";

/** Model XY (x=east, y=north) → Three.js XZ (z = south = −north). */
const toXZ = ([x, y]: [number, number]): [number, number] => [x, -y];

const Y_GROUND = 0.14;
const COLOR_IDLE = "#c2410c"; // deeper orange — distinct from indoor coral #ff8a6b
const COLOR_SEL = "#ea580c";
const LABEL_BG = "#7c2d12";

function LayLabel({ text, position }: { text: string; position: [number, number, number] }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#ffedd5";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    ctx.fillStyle = "#ffedd5";
    const font = text.length > 22 ? 34 : text.length > 16 ? 42 : 52;
    ctx.font = `500 ${font}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const map = new THREE.CanvasTexture(canvas);
    map.needsUpdate = true;
    return map;
  }, [text]);

  if (!texture) return null;
  const scale: [number, number, number] = [Math.min(5.2, 0.15 * text.length + 1.1), 0.4, 1];
  return (
    <sprite position={position} scale={scale}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function HoseLayRibbon({
  lay,
  selected,
  onSelect,
}: {
  lay: HoseLay;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const { gl } = useThree();
  const points = useMemo(
    () =>
      lay.path.map((p) => {
        const [x, z] = toXZ(p);
        return new THREE.Vector3(x, Y_GROUND, z);
      }),
    [lay.path],
  );

  const mid = useMemo((): [number, number, number] | null => {
    if (points.length < 2) return null;
    let half = lay.lengthM / 2;
    for (let i = 1; i < lay.path.length; i++) {
      const a = lay.path[i - 1]!;
      const b = lay.path[i]!;
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (half <= seg) {
        const t = seg > 0 ? half / seg : 0;
        const mx = a[0] + (b[0] - a[0]) * t;
        const my = a[1] + (b[1] - a[1]) * t;
        const [x, z] = toXZ([mx, my]);
        return [x, Y_GROUND + 0.55, z];
      }
      half -= seg;
    }
    const last = points[points.length - 1]!;
    return [last.x, Y_GROUND + 0.55, last.z];
  }, [lay.lengthM, lay.path, points]);

  const label = `${Math.round(lay.lengthFt)} ft · ${lay.loadHint} load`;
  const color = selected ? COLOR_SEL : COLOR_IDLE;
  const width = selected ? 5.5 : 3.2;

  const pick = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onSelect?.(lay.hydrantId);
  };

  if (points.length < 2) return null;

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={width}
        depthTest={false}
        renderOrder={selected ? 22 : 21}
        onClick={pick}
        onPointerOver={() => {
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
        }}
      />
      {/* Wider invisible strip so thin lines stay easy to click. */}
      <Line
        points={points}
        color={color}
        lineWidth={14}
        transparent
        opacity={0.001}
        depthTest={false}
        renderOrder={20}
        onClick={pick}
        onPointerOver={() => {
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
        }}
      />
      {mid && <LayLabel text={label} position={mid} />}
    </group>
  );
}

/**
 * Ground-level hose-lay ribbons (hydrant → Alpha entry). Mount inside the Viewer Canvas.
 */
export default function HoseLayOverlay({
  lays,
  selectedId,
  onSelect,
  visible = true,
}: {
  lays: HoseLay[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  visible?: boolean;
}) {
  if (!visible || !lays.length) return null;

  return (
    <group>
      {lays.map((lay) => (
        <HoseLayRibbon
          key={lay.hydrantId}
          lay={lay}
          selected={selectedId != null && selectedId === lay.hydrantId}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
