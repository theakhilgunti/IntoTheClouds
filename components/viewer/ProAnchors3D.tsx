"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { ANCHOR_COLOR, ANCHOR_UNSET_COLOR, type ProAnchor } from "@/lib/pro";
import FirefighterModel, { fighterRingColor } from "./FirefighterModel";
import { WalkMover, buildWalkGrid } from "@/lib/walk";
import type { Floor, Point } from "@/packages/schema/building-model";

const noop = () => null;
const PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/** Three draggable points around the house. Model frame x = east, y = north → three (x, _, -y). */
export default function ProAnchors3D({
  anchors,
  selectedId,
  onMove,
  onSelect,
}: {
  anchors: ProAnchor[];
  selectedId: string | null;
  onMove: (id: string, x: number, y: number) => void;
  onSelect: (id: string) => void;
}) {
  const { camera, gl, controls } = useThree();
  const drag = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
      if (!d.moved) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(PLANE, hit)) onMove(d.id, hit.x, -hit.z);
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (controls) (controls as unknown as { enabled: boolean }).enabled = true;
      el.style.cursor = "";
      if (d && !d.moved) onSelect(d.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [camera, gl, controls, onMove, onSelect]);

  const lines = useMemo(() => {
    const p = (a: ProAnchor) => new THREE.Vector3(a.x, 0.15, -a.y);
    return [
      [p(anchors[0]), p(anchors[1])],
      [p(anchors[1]), p(anchors[2])],
      [p(anchors[2]), p(anchors[0])],
    ];
  }, [anchors]);

  return (
    <group>
      {lines.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color="#ff8a6b"
          lineWidth={1.5}
          dashed
          dashSize={0.5}
          gapSize={0.35}
          depthTest={false}
          renderOrder={25}
          raycast={noop}
        />
      ))}
      {anchors.map((a) => (
        <AnchorDot
          key={a.id}
          anchor={a}
          selected={a.id === selectedId}
          onDown={(e) => {
            e.stopPropagation();
            if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
            gl.domElement.style.cursor = "grabbing";
            drag.current = { id: a.id, sx: e.nativeEvent.clientX, sy: e.nativeEvent.clientY, moved: false };
          }}
        />
      ))}
    </group>
  );
}

function AnchorDot({
  anchor,
  selected,
  onDown,
}: {
  anchor: ProAnchor;
  selected: boolean;
  onDown: (e: ThreeEvent<PointerEvent>) => void;
}) {
  const color = anchor.type ? ANCHOR_COLOR[anchor.type] : ANCHOR_UNSET_COLOR;
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const s = 1 + ((clock.elapsedTime * 0.8) % 1) * 1.6;
    ring.current.scale.set(s, s, s);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - ((clock.elapsedTime * 0.8) % 1));
  });
  return (
    <group
      position={[anchor.x, 0, -anchor.y]}
      onPointerDown={onDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        (e.nativeEvent.target as HTMLElement).style.cursor = "grab";
      }}
      onPointerOut={(e) => {
        (e.nativeEvent.target as HTMLElement).style.cursor = "";
      }}
    >
      {/* fat invisible hit target */}
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[1.1, 1.1, 2.6, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.9, 0]} renderOrder={26}>
        <cylinderGeometry args={[0.06, 0.06, 1.8, 8]} />
        <meshStandardMaterial color={color} depthTest={false} />
      </mesh>
      <mesh position={[0, 2, 0]} renderOrder={27}>
        <sphereGeometry args={[selected ? 0.9 : 0.7, 20, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1.1 : 0.55} depthTest={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, 0]} renderOrder={24}>
        <ringGeometry args={[0.5, 0.65, 32]} />
        <meshBasicMaterial color={color} transparent depthWrite={false} depthTest={false} />
      </mesh>
    </group>
  );
}

/** The tracked firefighter: pulsing marker plus breadcrumb trail, drawn on one floor. */
export function ProFirefighter({
  site,
  trail,
  y,
  fresh,
  floorLabel,
  lostSeconds,
  floor,
  footprint,
}: {
  /** The floor and outline whose walls stop the firefighter. */
  floor?: Floor;
  footprint: Point[];
  site: { x: number; y: number } | null;
  trail: { x: number; y: number }[];
  /** Height of the floor the marker stands on. */
  y: number;
  /** false when the feed has gone quiet — figure greys out. */
  fresh: boolean;
  floorLabel: string;
  /** Seconds since the last fix, shown while the signal is lost. */
  lostSeconds: number | null;
}) {
  const ring = useRef<THREE.Mesh>(null);
  const group = useRef<THREE.Group>(null);
  const walking = useRef(false);
  // Walls and doors of this floor; rebuilt when the floor changes.
  const grid = useMemo(() => (floor ? buildWalkGrid(floor, footprint) : null), [floor, footprint]);
  const mover = useRef<WalkMover | null>(null);
  // Breadcrumbs follow where the figure actually walked (not the noisy raw fixes, which cut through walls).
  const crumbs = useRef<Point[]>([]);
  const crumbClock = useRef(0);
  const [walked, setWalked] = useState<Point[]>([]);
  useEffect(() => {
    if (trail.length === 0) {
      crumbs.current = [];
      setWalked([]);
    }
  }, [trail.length]);
  useFrame(({ clock }, dt) => {
    const g = group.current;
    if (site && g) {
      if (!mover.current) mover.current = new WalkMover([site.x, site.y]);
      const step = dt > 0.1 ? 0.1 : dt;
      const r = grid
        ? mover.current.step(grid, [site.x, site.y], step)
        : (() => {
            // no wall data: just glide to the fix
            const m = mover.current!;
            const dx = site.x - m.pos[0];
            const dy = site.y - m.pos[1];
            m.pos = [m.pos[0] + dx * 0.25, m.pos[1] + dy * 0.25];
            return { moved: Math.hypot(dx, dy) > 0.01, dx, dy };
          })();
      g.position.set(mover.current.pos[0], y, -mover.current.pos[1]);
      walking.current = r.moved;
      const last = crumbs.current[crumbs.current.length - 1];
      const here = mover.current.pos;
      if (!last || Math.hypot(here[0] - last[0], here[1] - last[1]) > 0.3) {
        crumbs.current.push([here[0], here[1]]);
        if (crumbs.current.length > 400) crumbs.current.shift();
      }
      crumbClock.current += dt;
      if (crumbClock.current > 0.25) {
        crumbClock.current = 0;
        setWalked((w) => (w.length === crumbs.current.length ? w : [...crumbs.current]));
      }
      if (r.moved) {
        // model y (north) is three -z
        const want = Math.atan2(r.dx, -r.dy);
        let d = want - g.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        g.rotation.y += d * 0.25;
      }
    }
    if (ring.current) {
      const mat = ring.current.material as THREE.MeshBasicMaterial;
      if (fresh) {
        const k = (clock.elapsedTime * 1.1) % 1;
        ring.current.scale.setScalar(1 + k * 2.2);
        mat.opacity = 0.6 * (1 - k);
      } else {
        ring.current.scale.setScalar(1.6);
        mat.opacity = 0.45;
      }
    }
  });
  const pts = useMemo(() => walked.map((p) => new THREE.Vector3(p[0], y + 0.18, -p[1])), [walked, y]);
  const variant = fresh ? "live" : "lost";
  const ringColor = fighterRingColor(variant);
  if (!site) return null;
  return (
    <>
      {pts.length >= 2 && (
        <Line points={pts} color={fresh ? "#ffb199" : "#94a3b8"} lineWidth={2.5} depthTest={false} renderOrder={28} raycast={noop} transparent opacity={0.9} />
      )}
      <group ref={group} position={[site.x, y, -site.y]}>
        <FirefighterModel
          variant={variant}
          walking={walking}
          tag={fresh ? `FF-1 · ${floorLabel}` : `LAST SEEN ${Math.max(1, lostSeconds ?? 1)}s`}
        />
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.15, 0]} renderOrder={29}>
          <ringGeometry args={[0.5, 0.68, 32]} />
          <meshBasicMaterial color={ringColor} transparent depthWrite={false} depthTest={false} />
        </mesh>
      </group>
    </>
  );
}

export type DrillPhase = "idle" | "walking" | "spraying" | "out";
export interface FireScale {
  id: string;
  k: number;
}

const WALK_SPEED_MPS = 1.7;
const STOP_SHORT_M = 1.4;
const SPRAY_SECONDS = 3;

/**
 * Drill firefighter: walks the planned route (doors, stairs) toward a fire, sprays it, puts it out.
 * `path` is in three.js world coordinates and already includes floor heights, so stairs climb smoothly.
 */
export function ProResponder({
  path,
  phase,
  fire,
  onArrive,
  onOut,
}: {
  path: THREE.Vector3[];
  phase: DrillPhase;
  fire: { current: FireScale };
  onArrive: () => void;
  onOut: () => void;
}) {
  const group = useRef<THREE.Group>(null);
  const drops = useRef<(THREE.Mesh | null)[]>([]);
  const dist = useRef(0);
  const walkingRef = useRef(false);
  const sprayT = useRef(0);
  const fired = useRef(false);

  const { cum, total } = useMemo(() => {
    const c = [0];
    for (let i = 1; i < path.length; i++) c.push(c[i - 1] + path[i].distanceTo(path[i - 1]));
    return { cum: c, total: c[c.length - 1] ?? 0 };
  }, [path]);
  const walkLen = Math.max(0, total - STOP_SHORT_M);

  useEffect(() => {
    dist.current = 0;
    sprayT.current = 0;
    fired.current = false;
  }, [path]);

  const at = (d: number, out: THREE.Vector3, dir?: THREE.Vector3) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.max(1e-6, cum[i] - cum[i - 1]);
    out.copy(a).lerp(b, Math.min(1, Math.max(0, (d - cum[i - 1]) / seg)));
    if (dir) dir.copy(b).sub(a);
  };

  const tmp = useRef({ p: new THREE.Vector3(), d: new THREE.Vector3(), tgt: new THREE.Vector3() });
  useFrame((_, dt) => {
    const g = group.current;
    if (!g || path.length < 2 || phase === "idle") return;
    const { p, d, tgt } = tmp.current;
    walkingRef.current = phase === "walking";
    if (phase === "walking") {
      dist.current = Math.min(walkLen, dist.current + WALK_SPEED_MPS * Math.min(dt, 0.1));
      at(dist.current, p, d);
      g.position.copy(p);
      if (Math.hypot(d.x, d.z) > 1e-4) g.rotation.y = Math.atan2(d.x, d.z);
      if (dist.current >= walkLen && !fired.current) {
        fired.current = true;
        onArrive();
      }
    } else if (phase === "spraying") {
      sprayT.current += Math.min(dt, 0.1);
      fire.current.k = Math.max(0.04, 1 - sprayT.current / SPRAY_SECONDS);
      tgt.copy(path[path.length - 1]);
      tgt.y += 0.7;
      const hand = g.position.clone();
      hand.y += 1.2;
      drops.current.forEach((m, i) => {
        if (!m) return;
        const u = (sprayT.current * 1.6 + i / drops.current.length) % 1;
        m.position.lerpVectors(hand, tgt, u);
        m.position.y += Math.sin(u * Math.PI) * 0.4;
        m.visible = true;
      });
      if (sprayT.current >= SPRAY_SECONDS && fired.current) {
        fired.current = false;
        onOut();
      }
    } else {
      drops.current.forEach((m) => m && (m.visible = false));
    }
  });

  if (path.length < 2) return null;
  const hide = phase === "idle";
  return (
    <>
      <group ref={group} position={path[0].toArray()} visible={!hide}>
        <FirefighterModel variant="drill" walking={walkingRef} nozzle={phase === "spraying"} tag="DRILL" />
      </group>
      {Array.from({ length: 16 }).map((_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            drops.current[i] = m;
          }}
          visible={false}
          renderOrder={32}
        >
          <sphereGeometry args={[0.1, 8, 6]} />
          <meshBasicMaterial color="#7dd3fc" depthTest={false} transparent opacity={0.9} />
        </mesh>
      ))}
    </>
  );
}
