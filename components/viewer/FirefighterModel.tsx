"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type FighterVariant = "live" | "drill" | "lost";

const PALETTE: Record<
  FighterVariant,
  { coat: string; sleeve: string; helmet: string; badge: string; pants: string; stripe: string; ring: string; tag: string }
> = {
  live: { coat: "#ff4d2e", sleeve: "#e23d20", helmet: "#f4f1e8", badge: "#ff4d2e", pants: "#1f2937", stripe: "#f4f1e8", ring: "#ff4d2e", tag: "#ff8a6b" },
  drill: { coat: "#facc15", sleeve: "#d9ae0f", helmet: "#ef4444", badge: "#f4f1e8", pants: "#1f2937", stripe: "#f4f1e8", ring: "#facc15", tag: "#fde68a" },
  lost: { coat: "#94a3b8", sleeve: "#7b8794", helmet: "#cbd5e1", badge: "#94a3b8", pants: "#334155", stripe: "#cbd5e1", ring: "#94a3b8", tag: "#cbd5e1" },
};

/** The raw model is ~1.96 m with helmet; 0.92 makes it a normal 1.8 m firefighter in real metres. */
export const MARKER_SCALE = 0.92;

export const fighterRingColor = (v: FighterVariant) => PALETTE[v].ring;

/** Small floating name tag; redraws its canvas whenever the text changes. */
function Tag({ text, color }: { text: string; color: string }) {
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 72;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { canvas: c, tex: t };
  }, []);
  useEffect(() => {
    const g = canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#0b2e72";
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(3, 3, canvas.width - 6, canvas.height - 6, 33);
    g.fill();
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.arc(30, 36, 8, 0, Math.PI * 2);
    g.fill();
    g.font = "600 30px ui-monospace, Menlo, monospace";
    g.textBaseline = "middle";
    g.fillText(text, 52, 38);
    tex.needsUpdate = true;
  }, [canvas, tex, text, color]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <sprite position={[0, 2.3, 0]} scale={[1.4, 0.32, 1]} renderOrder={40}>
      <spriteMaterial map={tex} transparent depthTest={false} />
    </sprite>
  );
}

/**
 * Low-poly firefighter: helmet, turnout coat with reflective stripes, SCBA tank, boots.
 * Faces +z. `walking` (a ref, so no re-render per frame) swings the arms and legs.
 */
export default function FirefighterModel({
  variant,
  tag,
  walking,
  nozzle = false,
}: {
  variant: FighterVariant;
  tag?: string;
  walking?: MutableRefObject<boolean>;
  /** Drill: hold a hose nozzle out front. */
  nozzle?: boolean;
}) {
  const p = PALETTE[variant];
  const lost = variant === "lost";
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const bob = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 7.5;
    const w = walking?.current && !lost ? 1 : 0;
    const s = Math.sin(t) * 0.55 * w;
    if (legL.current) legL.current.rotation.x = s;
    if (legR.current) legR.current.rotation.x = -s;
    if (armL.current) armL.current.rotation.x = nozzle ? -0.9 : -s * 0.8;
    if (armR.current) armR.current.rotation.x = nozzle ? -0.9 : s * 0.8;
    if (bob.current) bob.current.position.y = Math.abs(Math.sin(t)) * 0.05 * w;
  });

  const m = (color: string, emissive = 0) => (
    <meshStandardMaterial
      color={color}
      emissive={color}
      emissiveIntensity={emissive}
      depthTest={false}
      transparent={lost}
      opacity={lost ? 0.7 : 1}
      roughness={0.7}
    />
  );

  return (
    <>
    <group scale={MARKER_SCALE}>
    <group ref={bob}>
      {/* SCBA air tank, behind the shoulders */}
      <mesh position={[0, 1.28, -0.24]} renderOrder={31}>
        <cylinderGeometry args={[0.11, 0.11, 0.55, 12]} />
        {m(lost ? "#64748b" : "#9ca3af")}
      </mesh>

      {/* legs + boots */}
      {[
        { x: -0.12, ref: legL },
        { x: 0.12, ref: legR },
      ].map(({ x, ref }) => (
        <group key={x} ref={ref} position={[x, 0.85, 0]}>
          <mesh position={[0, -0.35, 0]} renderOrder={32}>
            <boxGeometry args={[0.18, 0.7, 0.2]} />
            {m(p.pants)}
          </mesh>
          <mesh position={[0, -0.76, 0.03]} renderOrder={32}>
            <boxGeometry args={[0.2, 0.18, 0.3]} />
            {m(lost ? "#1e293b" : "#0b1220")}
          </mesh>
        </group>
      ))}

      {/* torso (turnout coat) */}
      <mesh position={[0, 1.2, 0]} renderOrder={33}>
        <boxGeometry args={[0.56, 0.7, 0.32]} />
        {m(p.coat, lost ? 0.1 : 0.5)}
      </mesh>
      {[1.06, 1.27].map((y) => (
        <mesh key={y} position={[0, y, 0]} renderOrder={34}>
          <boxGeometry args={[0.575, 0.07, 0.335]} />
          {m(p.stripe, lost ? 0.1 : 0.7)}
        </mesh>
      ))}

      {/* arms */}
      {[
        { x: -0.37, ref: armL },
        { x: 0.37, ref: armR },
      ].map(({ x, ref }) => (
        <group key={x} ref={ref} position={[x, 1.48, 0]}>
          <mesh position={[0, -0.3, 0]} renderOrder={33}>
            <boxGeometry args={[0.15, 0.6, 0.16]} />
            {m(p.sleeve, lost ? 0.1 : 0.4)}
          </mesh>
          <mesh position={[0, -0.62, 0]} renderOrder={33}>
            <sphereGeometry args={[0.085, 10, 8]} />
            {m(lost ? "#1e293b" : "#0b1220")}
          </mesh>
          {nozzle && x > 0 && (
            <mesh position={[0, -0.62, 0.25]} renderOrder={35}>
              <boxGeometry args={[0.1, 0.1, 0.5]} />
              {m("#e5e7eb")}
            </mesh>
          )}
        </group>
      ))}

      {/* neck + head */}
      <mesh position={[0, 1.6, 0]} renderOrder={34}>
        <boxGeometry args={[0.16, 0.12, 0.16]} />
        {m(lost ? "#94a3b8" : "#e0b48f")}
      </mesh>
      <mesh position={[0, 1.72, 0]} renderOrder={34}>
        <sphereGeometry args={[0.15, 14, 12]} />
        {m(lost ? "#94a3b8" : "#e0b48f")}
      </mesh>

      {/* helmet: dome, brim, front badge */}
      <mesh position={[0, 1.76, 0]} renderOrder={35}>
        <sphereGeometry args={[0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
        {m(p.helmet, lost ? 0 : 0.25)}
      </mesh>
      <mesh position={[0, 1.76, 0.02]} renderOrder={35}>
        <cylinderGeometry args={[0.27, 0.27, 0.035, 20]} />
        {m(p.helmet, 0)}
      </mesh>
      <mesh position={[0, 1.88, 0.19]} renderOrder={36}>
        <boxGeometry args={[0.12, 0.09, 0.03]} />
        {m(p.badge, 0.5)}
      </mesh>
    </group>
    </group>
      {tag && <Tag text={tag} color={p.tag} />}
    </>
  );
}
