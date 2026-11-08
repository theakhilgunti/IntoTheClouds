"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { Edges, Line, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import type {
  BuildingModel,
  CompoundFeature,
  Floor,
  LotGrade,
  Marker,
  MarkerType,
  Point,
  Roof,
  Room,
  Wall,
} from "@/packages/schema/building-model";
import { buildRoofPositions, type Pt } from "@/lib/roof-geom";
import {
  demExtent,
  demHeightfieldBuffers,
  gradeHeight,
  siteReach,
  terrainGridLinePositions,
} from "@/lib/compound-geom";
import { buildNav, routeToMarker, type Route } from "@/lib/route";
// Model frame: x = east, y = north. Three.js frame: x = east, y = up, z = south.
const toXZ = ([x, y]: Point): [number, number] => [x, -y];

/** After Shape/Extrude + rotateX(-π/2), vertices sit on XZ (z = −modelY). Lift by lot grade / DEM. */
function applyGradeToGeometry(geo: THREE.BufferGeometry, grade: LotGrade | null | undefined, extraY = 0) {
  if (!grade) return geo;
  if (!grade.dem && grade.slope <= 0) return geo;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const mx = pos.getX(i);
    const my = -pos.getZ(i);
    pos.setY(i, pos.getY(i) + gradeHeight([mx, my], grade) + extraY);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function LabelSprite({
  text,
  color,
  textColor = "#eaf1ff",
  scale,
  fit = false,
}: {
  text: string;
  color: string;
  textColor?: string;
  scale?: [number, number, number];
  fit?: boolean;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#eaf1ff";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    ctx.fillStyle = textColor;
    const font = text.length > 22 ? 36 : text.length > 14 ? 48 : 60;
    ctx.font = `500 ${font}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const map = new THREE.CanvasTexture(canvas);
    map.needsUpdate = true;
    return map;
  }, [text, color, textColor]);
  if (!texture) return null;
  const used = scale ?? (fit ? [Math.min(5, 0.16 * text.length + 0.8), 0.42, 1] as [number, number, number] : [1.8, 0.45, 1] as [number, number, number]);
  return (
    <sprite scale={used}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function noopRaycast() {}

/** Stable outline lines — plain Edges flicker away at glancing angles / fog. */
function SolidEdges({ color, threshold = 12 }: { color: string; threshold?: number }) {
  return (
    <Edges threshold={threshold} raycast={noopRaycast} renderOrder={2}>
      <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.92} toneMapped={false} />
    </Edges>
  );
}

const ROOM_WORDS: Record<Room["type"], string> = {
  living: "Living room",
  kitchen: "Kitchen",
  dining: "Dining room",
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  hallway: "Hall",
  stair: "Stairs",
  garage: "Garage",
  utility: "Utility",
  closet: "Closet",
  office: "Office",
  basement: "Basement",
  other: "Room / classroom",
};

const SITE_COLOR: Record<CompoundFeature["kind"], string> = {
  yard: "#14439c",
  driveway: "#3a68c4",
  patio: "#4a78d0",
  pool: "#6fa0ff",
  garage: "#2a5ab8",
  shed: "#2a5ab8",
  fence: "#9ebcff",
  trees: "#2f6bd0",
  road: "#0a2a68",
  signal: "#facc15",
  stop: "#ef4444",
  hydrant: "#dc2626",
  neighbor: "#8eb0e8",
  steps: "#c5d6f4",
  terrain: "#123a8a",
};

const SITE_NOTE: Record<CompoundFeature["source"], string> = {
  map: "From the map",
  aerial: "From the aerial photo",
  parcel: "City tax lot",
  estimated: "Estimated for the backyard",
};

const ROOM_COLORS: Record<Room["type"], string> = {
  living: "#c9daf8",
  kitchen: "#d3e0f9",
  dining: "#c9daf8",
  bedroom: "#bfd3f5",
  bathroom: "#d3e0f9",
  hallway: "#b4caf0",
  stair: "#ff8a6b",
  garage: "#a9c0ea",
  utility: "#d3e0f9",
  closet: "#a9c0ea",
  office: "#bfd3f5",
  basement: "#9db6e4",
  other: "#b4caf0",
};

const MARKER_STYLE: Record<MarkerType, { color: string; label: string }> = {
  fire: { color: "#ef4444", label: "FIRE" },
  victim: { color: "#22d3ee", label: "VICTIM" },
  gas: { color: "#a3e635", label: "GAS" },
  shutoff: { color: "#f97316", label: "SHUTOFF" },
  hazard: { color: "#eab308", label: "HAZARD" },
  entry: { color: "#ffffff", label: "ENTRY" },
};

const EXPLODE_GAP = 3;

/** Min solid remnant length — shorter crumbs read as free-standing pillars. */
const MIN_WALL_SEG = 0.42;

/** Split a wall into solid segments around its door openings. */
function wallSegments(wall: Wall, floor: Floor): Array<[number, number]> {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < MIN_WALL_SEG) return [];
  // Merge overlapping door gaps first.
  const rawGaps = floor.doors
    .filter((d) => d.wallId === wall.id)
    .map((d) => [Math.max(0, d.t * len - d.width / 2), Math.min(len, d.t * len + d.width / 2)] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const gaps: Array<[number, number]> = [];
  for (const g of rawGaps) {
    const last = gaps[gaps.length - 1];
    if (last && g[0] <= last[1] + 0.05) last[1] = Math.max(last[1], g[1]);
    else gaps.push([g[0], g[1]]);
  }
  // Absorb crumb stubs into neighboring openings so stair/exit walls don't leave pillars.
  const expanded = gaps.map(([s, e]) => {
    let s2 = s;
    let e2 = e;
    if (s2 > 0 && s2 < MIN_WALL_SEG) s2 = 0;
    if (e2 < len && len - e2 < MIN_WALL_SEG) e2 = len;
    return [s2, e2] as [number, number];
  });
  const segs: Array<[number, number]> = [];
  let cur = 0;
  for (const [s, e] of expanded) {
    if (s > cur + 1e-4) segs.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < len - 1e-4) segs.push([cur, len]);
  return segs.filter(([s, e]) => e - s >= MIN_WALL_SEG);
}

const WINDOW_FOR: Record<Room["type"], { every: number; max: number; h: number; y: number }> = {
  living: { every: 2.3, max: 2, h: 1.25, y: 0.2 },
  dining: { every: 2.5, max: 1, h: 1.15, y: 0.2 },
  kitchen: { every: 2.6, max: 1, h: 1.05, y: 0.25 },
  bedroom: { every: 2.4, max: 2, h: 1.15, y: 0.22 },
  bathroom: { every: 1.6, max: 1, h: 0.62, y: 0.5 },
  office: { every: 2.4, max: 1, h: 1.1, y: 0.22 },
  hallway: { every: 8, max: 1, h: 0.9, y: 0.3 },
  stair: { every: 99, max: 0, h: 0, y: 0 },
  garage: { every: 99, max: 0, h: 0, y: 0 },
  utility: { every: 4, max: 1, h: 0.7, y: 0.35 },
  closet: { every: 99, max: 0, h: 0, y: 0 },
  basement: { every: 99, max: 0, h: 0, y: 0 },
  other: { every: 3, max: 1, h: 1, y: 0.2 },
};

function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The room just inside this wall, so a bedroom gets one window and a hall gets almost none. */
function roomBeside(wall: Wall, floor: Floor, mid: Point): Room | null {
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) || 1;
  const nx = -(wall.b[1] - wall.a[1]) / len;
  const ny = (wall.b[0] - wall.a[0]) / len;
  for (const sign of [1, -1]) {
    const p: Point = [mid[0] + nx * sign * 0.45, mid[1] + ny * sign * 0.45];
    const room = floor.rooms.find((r) => pointInRing(p, r.polygon));
    if (room) return room;
  }
  return null;
}

function WallMesh({ wall, floor, xray, passPointer, assumed }: { wall: Wall; floor: Floor; xray: boolean; passPointer: boolean; assumed: boolean }) {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 0.01) return null;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const angle = Math.atan2(by - ay, bx - ax);
  const raycast = passPointer ? noopRaycast : undefined;
  const color = xray ? (wall.exterior ? "#eaf1ff" : "#9ebcff") : wall.exterior ? "#dfe9fc" : "#f3f7ff";
  const edge = "#0f3a8e";
  const faded = assumed && !wall.exterior;
  const showWindows = !xray && wall.exterior && floor.level >= 0;
  const doors = floor.doors.filter((d) => d.wallId === wall.id);

  return (
    <>
      {wallSegments(wall, floor).map(([s, e], i) => {
        const mid = (s + e) / 2;
        const [x, z] = toXZ([ax + ux * mid, ay + uy * mid]);
        const segLen = e - s;
        const segMid: Point = [ax + ux * mid, ay + uy * mid];
        const beside = showWindows ? roomBeside(wall, floor, segMid) : null;
        const budget = beside ? WINDOW_FOR[beside.type] : null;
        const nWin = budget ? Math.max(0, Math.min(budget.max, Math.floor((segLen - 0.5) / budget.every))) : 0;
        const winH = budget?.h ?? 1.1;
        const winY = budget?.y ?? 0.2;
        return (
          <group key={i} position={[x, floor.height / 2, z]} rotation={[0, angle, 0]}>
            <mesh raycast={raycast}>
              <boxGeometry args={[segLen, floor.height, wall.thickness]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={xray ? 0 : 0.3}
                wireframe={xray}
                transparent={xray || !wall.exterior}
                opacity={xray ? 0.9 : wall.exterior ? 1 : faded ? 0.55 : 0.92}
              />
              {!xray && <SolidEdges color={edge} threshold={12} />}
            </mesh>
            {Array.from({ length: nWin }, (_, k) => {
              const off = -segLen / 2 + (segLen / (nWin + 1)) * (k + 1);
              return (
                <mesh key={k} position={[off, winY, 0]} raycast={raycast}>
                  <boxGeometry args={[Math.min(0.95, segLen * 0.42), winH, wall.thickness + 0.04]} />
                  <meshStandardMaterial color="#0f3a8e" transparent opacity={0.85} />
                  <SolidEdges color="#0b2e72" threshold={1} />
                </mesh>
              );
            })}
          </group>
        );
      })}
      {doors
        .filter((d) => d.exit)
        .map((d) => {
          const along = d.t * len;
          const [x, z] = toXZ([ax + ux * along, ay + uy * along]);
          const h = Math.min(2.1, floor.height - 0.2);
          return (
            <mesh key={d.id} position={[x, h / 2, z]} rotation={[0, angle, 0]} raycast={raycast}>
              <boxGeometry args={[d.width, h, wall.thickness * 0.5]} />
              <meshStandardMaterial
                color="#ff8a6b"
                emissive="#ff8a6b"
                emissiveIntensity={xray ? 0.6 : 0.15}
                transparent={xray}
                opacity={xray ? 0.75 : 1}
              />
              {!xray && <SolidEdges color="#7a2e18" threshold={1} />}
            </mesh>
          );
        })}
    </>
  );
}

function RoomSlab({
  room,
  floorName,
  xray,
  showLabel,
  onPick,
  onOver,
  onOut,
  y = 0.08,
}: {
  room: Room;
  floorName: string;
  xray: boolean;
  showLabel: boolean;
  onPick: (e: ThreeEvent<MouseEvent>) => void;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
  y?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const geom = useMemo(() => {
    const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ShapeGeometry(shape);
  }, [room.polygon]);
  const center = useMemo(() => {
    const n = room.polygon.length;
    const cx = room.polygon.reduce((s, p) => s + p[0], 0) / n;
    const cy = room.polygon.reduce((s, p) => s + p[1], 0) / n;
    return toXZ([cx, cy]);
  }, [room.polygon]);
  const isStair = room.type === "stair";
  return (
    <group>
      <mesh
        geometry={geom}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, y, 0]}
        onClick={onPick}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          onOver(e, room.id, room.name, `${floorName} · ${ROOM_WORDS[room.type]}`);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHovered(false);
          onOut(room.id);
        }}
      >
        <meshStandardMaterial
          color={xray && !isStair ? "#0b2e72" : ROOM_COLORS[room.type]}
          emissive={hovered ? "#ffffff" : isStair ? "#ff8a6b" : "#000000"}
          emissiveIntensity={hovered ? 0.35 : isStair ? (xray ? 0.8 : 0.3) : 0}
          side={THREE.FrontSide}
          depthWrite
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>
      {showLabel && (
        <group position={[center[0], 0.7, center[1]]}>
          <LabelSprite text={room.name} color="#0b2e72" fit />
        </group>
      )}
    </group>
  );
}

/**
 * One sealed deck per floor for big complexes — avoids dozens of overlapping room
 * slabs z-fighting and tanking the frame rate.
 */
function SimpleFloorDeck({
  floor,
  footprint,
  xray,
  onPick,
  onOver,
  onOut,
  tipId,
}: {
  floor: Floor;
  footprint: Point[];
  xray: boolean;
  onPick: (e: ThreeEvent<MouseEvent>, room: Room | null) => void;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
  tipId: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const ring = footprint.length >= 3 ? footprint : floor.rooms[0]?.polygon ?? [];
  const geom = useMemo(() => {
    if (ring.length < 3) return null;
    const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ShapeGeometry(shape);
  }, [ring]);
  if (!geom) return null;
  return (
    <mesh
      geometry={geom}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.08, 0]}
      onClick={(e) => {
        e.stopPropagation();
        const p: Point = [e.point.x, -e.point.z];
        const room = floor.rooms.find((r) => pointInRing(p, r.polygon)) ?? null;
        onPick(e, room);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        const p: Point = [e.point.x, -e.point.z];
        const room = floor.rooms.find((r) => pointInRing(p, r.polygon));
        if (room) onOver(e, room.id, room.name, `${floor.name} · ${ROOM_WORDS[room.type]}`);
        else onOver(e, `deck-${floor.level}`, floor.name, "Floor deck");
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
        onOut(tipId ?? `deck-${floor.level}`);
      }}
    >
      <meshStandardMaterial
        color={xray ? "#0b2e72" : "#c5d6f4"}
        emissive={hovered ? "#ffffff" : "#000000"}
        emissiveIntensity={hovered ? 0.28 : 0}
        side={THREE.FrontSide}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
      />
    </mesh>
  );
}

/** Stack ground surfaces so large lots do not z-fight. Streets sit above driveways/parking. */
const LAYER_Y: Record<string, number> = {
  terrain: -0.04,
  yard: 0.0,
  driveway: 0.04,
  pool: 0.05,
  road: 0.08,
  patio: 0.09,
  fence: 0.0,
};

/** Draw order within coplanar ground pads (higher = later = on top). */
const LAYER_ORDER: Record<string, number> = {
  terrain: 0,
  yard: 1,
  driveway: 2,
  pool: 3,
  road: 4,
  patio: 5,
  fence: 6,
  steps: 7,
};

function groundMat(color: string, hovered: boolean, opts?: { transparent?: boolean; opacity?: number; offset?: number; noHover?: boolean }) {
  const lit = hovered && !opts?.noHover;
  return (
    <meshStandardMaterial
      color={color}
      emissive={lit ? "#ffffff" : "#000000"}
      emissiveIntensity={lit ? 0.25 : 0}
      roughness={0.95}
      transparent={opts?.transparent}
      opacity={opts?.opacity ?? 1}
      side={THREE.FrontSide}
      depthWrite={!(opts?.transparent && (opts.opacity ?? 1) < 1)}
      polygonOffset
      polygonOffsetFactor={opts?.offset ?? -1}
      polygonOffsetUnits={opts?.offset ?? -1}
    />
  );
}

/** Real outdoor topography from the site DEM (one vertex per sample). */
function DemTerrainMesh({
  grade,
  footprint,
  hovered,
  onOver,
  onOut,
}: {
  grade: LotGrade;
  footprint: Point[];
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
}) {
  const geo = useMemo(() => {
    const dem = grade.dem;
    if (!dem) return null;
    const fp =
      footprint.length >= 3
        ? footprint
        : ([[-10, -10], [10, -10], [10, 10], [-10, 10]] as Point[]);
    const radius = siteReach(fp);
    const buf = demHeightfieldBuffers(dem, { yBias: LAYER_Y.terrain, radiusM: radius });
    if (!buf) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buf.positions, 3));
    g.setIndex(new THREE.BufferAttribute(buf.indices, 1));
    g.computeVertexNormals();
    return g;
  }, [grade.dem, footprint]);
  if (!geo || !grade.dem) return null;
  const src = grade.dem.source;
  return (
    <mesh
      geometry={geo}
      onPointerOver={(e) => {
        e.stopPropagation();
        onOver(e, "terrain-dem", "Site elevation", `Outdoor ground from ${src} — heights relative to the house slab`);
      }}
      onPointerOut={() => onOut("terrain-dem")}
    >
      {groundMat(SITE_COLOR.terrain, hovered, {
        transparent: true,
        opacity: hovered ? 0.62 : 0.48,
        offset: -6,
        noHover: false,
      })}
    </mesh>
  );
}

/** Ground reference grid warped to lot grade / DEM so hills read as terrain, not a flat table. */
function TerrainGrid({
  grade,
  size,
  divisions,
}: {
  grade: LotGrade | null | undefined;
  size: number;
  divisions: number;
}) {
  const geo = useMemo(() => {
    const pos = terrainGridLinePositions(grade, size, divisions, {
      yBias: -0.1,
      subdivide: grade?.dem ? 4 : grade && grade.slope > 0 ? 2 : 1,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, [grade, size, divisions]);
  return (
    <lineSegments geometry={geo} raycast={noopRaycast}>
      <lineBasicMaterial color="#3d6ec4" transparent opacity={0.55} depthWrite={false} />
    </lineSegments>
  );
}

/** Attached / next-door house: faded extruded shell — obstacle context, not the focus model. */
function NeighborMesh({
  feature,
  hovered,
  onOver,
  onOut,
  grade,
}: {
  feature: CompoundFeature;
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
  grade?: LotGrade | null;
}) {
  const wallH = Math.max(3.5, Math.min(14, feature.height || 5.5));
  const geo = useMemo(() => {
    if (feature.polygon.length < 3) return null;
    const shape = new THREE.Shape(feature.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: wallH, bevelEnabled: false, steps: 1 });
    g.rotateX(-Math.PI / 2);
    applyGradeToGeometry(g, grade);
    return g;
  }, [feature.polygon, wallH, grade]);
  if (!geo) return null;
  const hasAddr = feature.label && feature.label !== "Neighbor" && feature.label !== "Nearby house";
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onOver(
      e,
      feature.id,
      hasAddr ? feature.label : "Nearby house",
      hasAddr ? "Neighbor address from OpenStreetMap" : "Nearby building — address not mapped",
    );
  };
  return (
    <mesh geometry={geo} position={[0, 0, 0]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
      <meshStandardMaterial
        color={hovered ? "#c5d6f4" : SITE_COLOR.neighbor}
        transparent
        opacity={hovered ? 0.42 : 0.22}
        depthWrite={false}
        roughness={0.95}
        metalness={0}
        side={THREE.DoubleSide}
      />
      <SolidEdges color="#eaf1ff" threshold={18} />
    </mesh>
  );
}

/** Garage / shed: wall ring + simple gable roof instead of a solid cheese block. */
function OutbuildingMesh({
  feature,
  hovered,
  onOver,
  onOut,
  grade,
}: {
  feature: CompoundFeature;
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
  grade?: LotGrade | null;
}) {
  const wallH = Math.max(2.2, feature.height || 2.6);
  const roofH = Math.min(2.2, Math.max(1.1, wallH * 0.35));
  const baseY = useMemo(() => {
    const n = feature.polygon.length || 1;
    const c = feature.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Point, [0, 0] as Point);
    return gradeHeight([c[0] / n, c[1] / n], grade);
  }, [feature.polygon, grade]);
  const walls = useMemo(() => {
    const ring = feature.polygon;
    const out: { key: string; pos: [number, number, number]; rot: number; len: number }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.15) continue;
      const [x, z] = toXZ([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      out.push({ key: `${i}`, pos: [x, baseY + wallH / 2, z], rot: Math.atan2(b[1] - a[1], b[0] - a[0]), len });
    }
    return out;
  }, [feature.polygon, wallH, baseY]);
  const roofGeo = useMemo(() => {
    const poly = feature.polygon as Pt[];
    if (poly.length < 3) return null;
    const positions = buildRoofPositions(poly, {
      shape: "hip",
      ridgeAlong: "depth",
      height: roofH,
      wings: [{ polygon: poly, height: roofH, shape: "hip" }],
    });
    if (positions.length < 9) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }, [feature.polygon, roofH]);
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onOver(e, feature.id, feature.label, SITE_NOTE[feature.source]);
  };
  const color = hovered ? "#cfdcf6" : SITE_COLOR[feature.kind];
  return (
    <group onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
      {walls.map((w) => (
        <mesh key={w.key} position={w.pos} rotation={[0, w.rot, 0]}>
          <boxGeometry args={[w.len, wallH, 0.22]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, baseY + 0.02, 0]}>
        <shapeGeometry args={[new THREE.Shape(feature.polygon.map(([x, y]) => new THREE.Vector2(x, y)))]} />
        <meshStandardMaterial color="#2a5ab8" roughness={1} />
      </mesh>
      {roofGeo && (
        <group position={[0, baseY + wallH, 0]}>
          <mesh geometry={roofGeo} raycast={noopRaycast}>
            <meshStandardMaterial
              color="#1c3f86"
              roughness={0.92}
              metalness={0}
              flatShading
              depthWrite
              side={THREE.DoubleSide}
            />
            <SolidEdges color="#eaf1ff" threshold={15} />
          </mesh>
        </group>
      )}
    </group>
  );
}

/** Tall pulsing red beacon — rank 0 is nearest (tallest); farther ranks step down. */
function HydrantBeacon({
  position,
  hovered,
  onOver,
  onOut,
  rank = 0,
  label = "Nearest hydrant",
}: {
  position: [number, number, number];
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>) => void;
  onOut: () => void;
  rank?: number;
  label?: string;
}) {
  const glow = useRef<THREE.MeshStandardMaterial>(null);
  const beam = useRef<THREE.MeshStandardMaterial>(null);
  const mastH = Math.max(12, 28 - rank * 2);
  const tipY = 1.2 + mastH;
  const phase = rank * 0.9;
  const strength = rank === 0 ? 1 : Math.max(0.45, 0.85 - rank * 0.06);
  useFrame(({ clock }) => {
    const pulse = 0.55 + Math.sin(clock.elapsedTime * 3.2 + phase) * 0.45;
    if (glow.current) glow.current.emissiveIntensity = hovered ? 1.6 : pulse * strength;
    if (beam.current) beam.current.opacity = (0.18 + pulse * 0.28) * strength;
  });
  return (
    <group position={position} onPointerOver={onOver} onPointerOut={onOut}>
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.32, 0.38, 0.22, 10]} />
        <meshStandardMaterial color="#1f2937" metalness={0.35} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.65, 0]}>
        <cylinderGeometry args={[0.24, 0.26, 0.85, 10]} />
        <meshStandardMaterial color="#dc2626" metalness={0.2} roughness={0.4} emissive="#dc2626" emissiveIntensity={rank === 0 ? 0.4 : 0.25} />
      </mesh>
      <mesh position={[0.3, 0.72, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.08, 0.09, 0.26, 8]} />
        <meshStandardMaterial color="#dc2626" />
      </mesh>
      <mesh position={[-0.3, 0.72, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.08, 0.09, 0.26, 8]} />
        <meshStandardMaterial color="#dc2626" />
      </mesh>
      <mesh position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.13, 0.16, 0.22, 8]} />
        <meshStandardMaterial color="#f8fafc" metalness={0.4} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.2 + mastH / 2, 0]}>
        <cylinderGeometry args={[0.05, 0.085, mastH, 10]} />
        <meshStandardMaterial color="#7f1d1d" metalness={0.3} roughness={0.45} />
      </mesh>
      <mesh position={[0, 1.2 + mastH / 2, 0]} raycast={noopRaycast}>
        <cylinderGeometry args={[0.45, 0.75, mastH + 1.5, 14]} />
        <meshStandardMaterial
          ref={beam}
          color="#ef4444"
          emissive="#ef4444"
          emissiveIntensity={1.1}
          transparent
          opacity={0.32}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, tipY, 0]}>
        <sphereGeometry args={[rank === 0 ? 0.45 : 0.32, 14, 14]} />
        <meshStandardMaterial ref={glow} color="#fecaca" emissive="#ef4444" emissiveIntensity={1} toneMapped={false} />
      </mesh>
      <mesh position={[0, tipY, 0]} raycast={noopRaycast}>
        <sphereGeometry args={[rank === 0 ? 1.1 : 0.75, 14, 14]} />
        <meshBasicMaterial color="#ef4444" transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <group position={[0, tipY + 1.0, 0]}>
        <LabelSprite text={label} color="#7f1d1d" fit />
      </group>
    </group>
  );
}

function SiteFeatureMesh({
  feature,
  hovered,
  onOver,
  onOut,
  beacon = false,
  beaconRank = 0,
  grade = null,
}: {
  feature: CompoundFeature;
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
  /** Tall red sky beacon for a nearby hydrant POI. */
  beacon?: boolean;
  beaconRank?: number;
  grade?: LotGrade | null;
}) {
  const centerModel = useMemo(() => {
    const n = feature.polygon.length || 1;
    const c = feature.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Point, [0, 0] as Point);
    return [c[0] / n, c[1] / n] as Point;
  }, [feature.polygon]);
  const center = useMemo(() => toXZ(centerModel), [centerModel]);
  const gy = gradeHeight(centerModel, grade);

  const slabY =
    feature.kind === "terrain"
      ? LAYER_Y.terrain
      : feature.kind === "yard"
        ? LAYER_Y.yard
        : feature.kind === "road"
          ? LAYER_Y.road
          : feature.kind === "driveway"
            ? LAYER_Y.driveway
            : feature.kind === "patio"
              ? LAYER_Y.patio
              : feature.kind === "pool"
                ? LAYER_Y.pool
                : feature.kind === "steps"
                  ? 0
                  : LAYER_Y.fence;

  const stepRiser = 0.16;
  const isBuildingPad = feature.kind === "terrain" && feature.id !== "terrain-radius";
  const slabGeo = useMemo(() => {
    if (
      feature.kind === "trees" ||
      feature.kind === "garage" ||
      feature.kind === "shed" ||
      feature.kind === "hydrant" ||
      feature.kind === "signal" ||
      feature.kind === "stop" ||
      feature.kind === "neighbor"
    )
      return null;
    if (feature.polygon.length < 3) return null;
    if (feature.kind === "steps") {
      const shape = new THREE.Shape(feature.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: stepRiser, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      return g;
    }
    const simplified =
      feature.polygon.length > 24
        ? feature.polygon.filter((_, i) => i % Math.ceil(feature.polygon.length / 16) === 0)
        : feature.polygon;
    if (simplified.length < 3) return null;
    const shape = new THREE.Shape(simplified.map(([x, y]) => new THREE.Vector2(x, y)));
    // Fences need height; ground pads stay flat ShapeGeometry (cheaper, less z-fight).
    if (feature.kind === "fence") {
      const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.8, feature.height), bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      applyGradeToGeometry(g, grade);
      return g;
    }
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    // Building pads: keep flat and lift as a rigid plate. Vertex-warping a coarse outline
    // against a DEM produces twisted "cheese" under the house / neighbors.
    if (isBuildingPad) return g;
    applyGradeToGeometry(g, grade);
    return g;
  }, [feature.kind, feature.polygon, feature.height, grade, stepRiser, isBuildingPad]);

  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onOver(
      e,
      feature.id,
      feature.label,
      feature.kind === "steps"
        ? "Estimated front entry stairs"
        : feature.kind === "terrain"
          ? feature.id === "terrain-radius"
            ? grade?.dem
              ? `Mapped elevation (${grade.dem.source})`
              : "Estimated ground grade across the mapped neighborhood radius"
            : grade?.dem
              ? "Building pad following site elevation"
              : "Estimated ground grade under buildings"
          : SITE_NOTE[feature.source],
    );
  };

  if (feature.kind === "steps") {
    if (!slabGeo) return null;
    // feature.height is the absolute top Y of this tread (slab ≈ 0).
    return (
      <mesh
        geometry={slabGeo}
        position={[0, feature.height - stepRiser, 0]}
        onPointerOver={hover}
        onPointerOut={() => onOut(feature.id)}
      >
        <meshStandardMaterial
          color={hovered ? "#eaf1ff" : SITE_COLOR.steps}
          roughness={0.85}
          emissive={hovered ? "#ffffff" : "#000000"}
          emissiveIntensity={hovered ? 0.2 : 0}
        />
      </mesh>
    );
  }

  if (feature.kind === "trees") {
    return (
      <group position={[center[0], gy, center[1]]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
        <mesh position={[0, 1.1, 0]}>
          <cylinderGeometry args={[0.14, 0.2, 2.2, 6]} />
          <meshStandardMaterial color="#9ebcff" />
        </mesh>
        <mesh position={[0, 2.8, 0]}>
          <coneGeometry args={[1.3, 2.4, 7]} />
          <meshStandardMaterial color={hovered ? "#6fa0ff" : SITE_COLOR.trees} />
        </mesh>
      </group>
    );
  }

  if (feature.kind === "signal") {
    return (
      <group position={[center[0], gy, center[1]]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
        <mesh position={[0, 1.6, 0]}>
          <cylinderGeometry args={[0.08, 0.1, 3.2, 8]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.4} roughness={0.55} />
        </mesh>
        <mesh position={[0, 3.35, 0]}>
          <boxGeometry args={[0.35, 0.85, 0.28]} />
          <meshStandardMaterial color="#111827" roughness={0.7} />
        </mesh>
        {([0.25, 0, -0.25] as const).map((y, i) => (
          <mesh key={i} position={[0.2, 3.35 + y, 0]}>
            <sphereGeometry args={[0.09, 10, 10]} />
            <meshStandardMaterial
              color={i === 0 ? "#ef4444" : i === 1 ? "#facc15" : "#22c55e"}
              emissive={i === 0 ? "#ef4444" : i === 1 ? "#facc15" : "#22c55e"}
              emissiveIntensity={hovered ? 1.2 : 0.65}
            />
          </mesh>
        ))}
      </group>
    );
  }

  if (feature.kind === "stop") {
    const red = hovered ? "#f87171" : SITE_COLOR.stop;
    return (
      <group position={[center[0], gy, center[1]]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
        <mesh position={[0, 1.2, 0]}>
          <cylinderGeometry args={[0.045, 0.055, 2.4, 8]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.45} roughness={0.5} />
        </mesh>
        {/* Upright octagon (coin on its edge) — flat face toward the street. */}
        <mesh position={[0, 2.55, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.38, 0.38, 0.05, 8]} />
          <meshStandardMaterial color={red} emissive={red} emissiveIntensity={hovered ? 0.5 : 0.22} roughness={0.55} />
        </mesh>
        <mesh position={[0.028, 2.55, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.28, 0.28, 0.02, 8]} />
          <meshStandardMaterial color="#fef2f2" roughness={0.7} />
        </mesh>
      </group>
    );
  }

  if (feature.kind === "hydrant") {
    if (beacon) {
      const label =
        beaconRank === 0 ? "Nearest hydrant" : beaconRank === 1 ? "Hydrant #2" : `Hydrant #${beaconRank + 1}`;
      return (
        <HydrantBeacon
          position={[center[0], gy, center[1]]}
          hovered={hovered}
          onOver={hover}
          onOut={() => onOut(feature.id)}
          rank={beaconRank}
          label={label}
        />
      );
    }
    const red = hovered ? "#f87171" : SITE_COLOR.hydrant;
    return (
      <group position={[center[0], gy, center[1]]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)} scale={1.35}>
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noopRaycast}>
          <circleGeometry args={[0.4, 12]} />
          <meshStandardMaterial color="#7f1d1d" transparent opacity={0.45} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0.1, 0]}>
          <cylinderGeometry args={[0.22, 0.26, 0.16, 10]} />
          <meshStandardMaterial color="#1f2937" metalness={0.35} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0.48, 0]}>
          <cylinderGeometry args={[0.16, 0.18, 0.6, 10]} />
          <meshStandardMaterial color={red} metalness={0.25} roughness={0.45} emissive={red} emissiveIntensity={hovered ? 0.4 : 0.15} />
        </mesh>
        <mesh position={[0, 0.88, 0]}>
          <cylinderGeometry args={[0.09, 0.11, 0.16, 8]} />
          <meshStandardMaterial color="#f8fafc" metalness={0.4} roughness={0.4} />
        </mesh>
      </group>
    );
  }

  if (feature.kind === "neighbor") {
    return <NeighborMesh feature={feature} hovered={hovered} onOver={onOver} onOut={onOut} grade={grade} />;
  }

  if (feature.kind === "garage" || feature.kind === "shed") {
    return <OutbuildingMesh feature={feature} hovered={hovered} onOver={onOver} onOut={onOut} grade={grade} />;
  }

  if (!slabGeo) return null;
  // More negative polygonOffset pulls a surface toward the camera. Roads must win over
  // driveways/parking (parking lots are kind "driveway") so streets never clip underneath.
  const offset =
    feature.kind === "terrain"
      ? -5
      : feature.kind === "yard"
        ? -4
        : feature.kind === "driveway"
          ? -2
          : feature.kind === "road"
            ? -6
            : feature.kind === "pool"
              ? -3
              : -1;
  // Main house pad stays at slab level (DEM is relative to y=0). Neighbor pads ride the DEM as flat plates.
  const padY = isBuildingPad
    ? feature.id === "terrain-main"
      ? slabY
      : slabY + gy
    : slabY;
  const drawOrder = LAYER_ORDER[feature.kind] ?? 1;
  return (
    <mesh
      geometry={slabGeo}
      position={[0, padY, 0]}
      renderOrder={drawOrder}
      onPointerOver={hover}
      onPointerOut={() => onOut(feature.id)}
    >
      {groundMat(SITE_COLOR[feature.kind], hovered, {
        transparent: feature.kind === "pool" || feature.kind === "terrain",
        opacity:
          feature.kind === "pool"
            ? 0.88
            : feature.kind === "terrain"
              ? feature.id === "terrain-radius"
                ? 0.42
                : feature.id === "terrain-main"
                  ? 0.55
                  : 0.7
              : 1,
        offset,
        noHover: feature.kind === "yard" || feature.id === "terrain-radius" || feature.id === "terrain-apron" || feature.id === "terrain-main",
      })}
    </mesh>
  );
}

/**
 * Roof sits on the mapped eaves outline.
 * Stepped / concave footprints get a hip-style falloff so the mesh does not tear.
 */
function RoofMesh({ roof, footprint, baseY, xray }: { roof: Roof; footprint: Point[]; baseY: number; xray: boolean }) {
  const geometry = useMemo(() => {
    // Inferred plans are already in the model frame (east/north); mesh them in place.
    if (roof.plan?.wings?.length) {
      const positions = buildRoofPositions(footprint, {
        shape: roof.shape,
        ridgeAlong: roof.ridgeAlong ?? (roof.depth >= roof.width ? "depth" : "width"),
        height: roof.height,
        wings: roof.plan.wings.map((w) => ({
          polygon: w.polygon,
          ridge: w.ridge,
          height: w.height,
          shape: w.shape,
        })),
      });
      if (positions.length < 9) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      return { geo, framed: false as const };
    }

    const ring = roof.polygon?.length ? roof.polygon : footprint;
    const cos = Math.cos(roof.rotation);
    const sin = Math.sin(roof.rotation);
    const local: Pt[] = ring.map(([x, y]) => {
      const dx = x - roof.center[0];
      const dy = y - roof.center[1];
      return [dx * cos + dy * sin, -dx * sin + dy * cos];
    });
    const positions = buildRoofPositions(local, {
      shape: roof.shape,
      ridgeAlong: roof.ridgeAlong ?? (roof.depth >= roof.width ? "depth" : "width"),
      height: roof.height,
    });
    if (positions.length < 9) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return { geo, framed: true as const };
  }, [roof, footprint]);

  if (!geometry) return null;
  const roofMat = (
    <>
      <meshStandardMaterial
        color={xray ? "#9ebcff" : "#1c3f86"}
        wireframe={xray}
        transparent={!!xray}
        opacity={xray ? 0.35 : 1}
        roughness={0.92}
        metalness={0}
        flatShading
        depthWrite={!xray}
        side={THREE.DoubleSide}
      />
      {!xray && <SolidEdges color="#eaf1ff" threshold={15} />}
    </>
  );
  if (!geometry.framed) {
    return (
      <group position={[0, baseY, 0]}>
        <mesh geometry={geometry.geo} raycast={noopRaycast}>
          {roofMat}
        </mesh>
      </group>
    );
  }
  const [x, z] = toXZ(roof.center);
  return (
    <group position={[x, baseY, z]} rotation={[0, roof.rotation, 0]}>
      <mesh geometry={geometry.geo} raycast={noopRaycast}>
        {roofMat}
      </mesh>
    </group>
  );
}

function MarkerPin({ marker, onDelete }: { marker: Marker; onDelete: (id: string) => void }) {
  const style = MARKER_STYLE[marker.type];
  const [x, z] = toXZ(marker.pos);
  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation(); // don't also drop a new marker on the room underneath
        onDelete(marker.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      <mesh position={[0, 0.6, 0]}>
        <coneGeometry args={[0.35, 1.2, 16]} />
        <meshStandardMaterial color={style.color} emissive={style.color} emissiveIntensity={0.8} />
      </mesh>
      <group position={[0, 1.55, 0]}>
        <LabelSprite text={style.label} color={style.color} scale={[1.2, 0.32, 1]} />
      </group>
    </group>
  );
}

/** Wrap angle to [-π, π]. */
function wrapPi(a: number) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Direction from the house toward the nearest mapped road point (plan east/north). */
function nearestStreetDir(model: BuildingModel): [number, number] | null {
  const roads = model.compound?.features.filter((f) => f.kind === "road") ?? [];
  if (!roads.length) return null;
  const fp = model.footprint;
  const cx = fp.reduce((s, p) => s + p[0], 0) / (fp.length || 1);
  const cy = fp.reduce((s, p) => s + p[1], 0) / (fp.length || 1);
  let bestD = Infinity;
  let best: [number, number] | null = null;
  for (const r of roads) {
    for (const [x, y] of r.polygon) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [x - cx, y - cy];
      }
    }
  }
  if (!best) return null;
  const len = Math.hypot(best[0], best[1]) || 1;
  return [best[0] / len, best[1] / len];
}

/**
 * Orbit azimuth so rotate 0° faces the front door (camera sits outside looking in).
 * Model frame: +x east, +y north. Three.js: +x east, +z = south (−plan y).
 * Azimuth = atan2(outwardEast, −outwardNorth).
 */
function streetFrontYaw(model: BuildingModel): number {
  const street = nearestStreetDir(model);
  const floor =
    model.floors.find((f) => f.level === 0 && f.doors.some((d) => d.exit)) ??
    model.floors.find((f) => f.level >= 0 && f.doors.some((d) => d.exit)) ??
    model.floors.find((f) => f.doors.some((d) => d.exit));
  if (floor) {
    const fp = model.footprint;
    const cx = fp.reduce((s, p) => s + p[0], 0) / (fp.length || 1);
    const cy = fp.reduce((s, p) => s + p[1], 0) / (fp.length || 1);
    const roomPts = floor.rooms.flatMap((r) => r.polygon);
    const mid: [number, number] = roomPts.length
      ? [roomPts.reduce((s, p) => s + p[0], 0) / roomPts.length, roomPts.reduce((s, p) => s + p[1], 0) / roomPts.length]
      : [cx, cy];

    type Cand = { east: number; north: number; atY: number; named: boolean; streetDot: number };
    const cands: Cand[] = [];
    for (const door of floor.doors) {
      if (!door.exit) continue;
      const wall = floor.walls.find((w) => w.id === door.wallId);
      if (!wall) continue;
      const at: [number, number] = [
        wall.a[0] + (wall.b[0] - wall.a[0]) * door.t,
        wall.a[1] + (wall.b[1] - wall.a[1]) * door.t,
      ];
      const dx = wall.b[0] - wall.a[0];
      const dy = wall.b[1] - wall.a[1];
      const len = Math.hypot(dx, dy) || 1;
      // Start with left-of-wall normal, then force it outward (away from interior).
      let nx = -dy / len;
      let ny = dx / len;
      if ((mid[0] - at[0]) * nx + (mid[1] - at[1]) * ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      cands.push({
        east: nx,
        north: ny,
        atY: at[1],
        named: /front/i.test(door.id),
        streetDot: street ? nx * street[0] + ny * street[1] : 0,
      });
    }
    if (cands.length) {
      // Named "front" first; else the exit facing the nearest street; else southernmost.
      cands.sort((a, b) => {
        if (a.named !== b.named) return a.named ? -1 : 1;
        if (street && Math.abs(a.streetDot - b.streetDot) > 0.05) return b.streetDot - a.streetDot;
        return a.atY - b.atY;
      });
      const best = cands[0];
      return Math.atan2(best.east, -best.north);
    }
  }

  // Entry marker placed by the user / scan — stand outside looking toward the house center.
  const entry = model.markers.find((m) => m.type === "entry");
  if (entry) {
    const fp = model.footprint;
    const cx = fp.reduce((s, p) => s + p[0], 0) / (fp.length || 1);
    const cy = fp.reduce((s, p) => s + p[1], 0) / (fp.length || 1);
    const east = entry.pos[0] - cx;
    const north = entry.pos[1] - cy;
    if (Math.hypot(east, north) > 0.2) return Math.atan2(east, -north);
  }

  // No door: stand on the nearest street looking at the house.
  if (street) return Math.atan2(street[0], -street[1]);

  // Layout convention: front is plan −y → Three +Z → yaw 0.
  return 0;
}

// Collapsing slot for the CloudScan card, which sits directly under the icon row. The grid-track trick animates
// the slot to zero height (so what's below closes up with no gap), while the inner box pops in with a springy
// scale. Font size comes from one value so the card's box and text always scale together.
function CardSlot({ open, scale, children }: { open: boolean; scale: number; children: ReactNode }) {
  return (
    <div
      className="grid min-w-0 transition-[grid-template-rows] duration-300 ease-out"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        <div
          className="pointer-events-auto w-max max-w-full origin-top-left"
          style={{
            fontSize: `${12 * scale}px`,
            opacity: open ? 1 : 0,
            transform: open ? "none" : "translateY(-14px) scale(0.9)",
            transition: `transform 350ms cubic-bezier(.34,1.56,.64,1), opacity 200ms, visibility 0s linear ${open ? "0s" : "350ms"}`,
            visibility: open ? "visible" : "hidden",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

const iconBtn =
  "pointer-events-auto flex h-9 w-8 shrink-0 items-center justify-center border border-bp-ink/60 bg-bp-deep text-bp-ink hover:bg-bp-ink/15";

export default function Viewer({
  model,
  onReady,
  card,
  badge,
  onDownload,
}: {
  model: BuildingModel;
  onReady?: () => void;
  card?: ReactNode;
  badge?: ReactNode;
  onDownload?: () => void;
}) {
  const levels = model.floors.map((f) => f.level);
  const topLevel = Math.max(...levels);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [exploded, setExploded] = useState(false);
  const [xray, setXray] = useState(false);
  const [roofOn, setRoofOn] = useState(true);
  const [hydrantBeaconOn, setHydrantBeaconOn] = useState(true);
  const [tool, setTool] = useState<MarkerType | null>(null);
  const [marksOpen, setMarksOpen] = useState(false);
  const [help, setHelp] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>(model.markers);
  const assumed = model.interior?.status !== "verified";
  const wrap = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  // Rotate slider 0 = front door. Tilt 1 = highest (top-down).
  const MIN_POLAR = 0.16;
  const MAX_POLAR = Math.PI * 0.48;
  const polarFromTilt = (t: number) => MAX_POLAR - Math.min(1, Math.max(0, t)) * (MAX_POLAR - MIN_POLAR);
  const tiltFromPolar = (p: number) => (MAX_POLAR - p) / (MAX_POLAR - MIN_POLAR);
  const frontYaw = useMemo(() => streetFrontYaw(model), [model]);
  const [orbitYaw, setOrbitYaw] = useState(0);
  const [tiltAmt, setTiltAmt] = useState(0.42);
  const applyingOrbit = useRef(false);
  /** When true, orbit state came from drag — don't write angles back into OrbitControls. */
  const orbitFromDrag = useRef(false);
  // New house → snap rotate 0° back to that house's front door.
  useEffect(() => {
    setOrbitYaw(0);
    orbitFromDrag.current = false;
  }, [model.id]);
  const [tip, setTip] = useState<{ id: string; title: string; detail: string; x: number; y: number } | null>(null);

  const showTip = (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => {
    const rect = wrap.current?.getBoundingClientRect();
    const canvas = e.nativeEvent.target;
    if (canvas instanceof HTMLElement) canvas.style.cursor = "pointer";
    const rawX = e.nativeEvent.clientX - (rect?.left ?? 0) + 14;
    const rawY = e.nativeEvent.clientY - (rect?.top ?? 0) + 16;
    setTip({
      id,
      title,
      detail,
      x: Math.max(8, Math.min(rawX, (rect?.width ?? 320) - 176)),
      y: Math.max(8, Math.min(rawY, (rect?.height ?? 240) - 56)),
    });
  };
  const hideTip = (id: string) => {
    const canvas = wrap.current?.querySelector("canvas");
    if (canvas) canvas.style.cursor = "";
    setTip((current) => (current?.id === id ? null : current));
  };

  const toggleFloor = (lv: number) => {
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(lv)) {
        // Showing this floor.
        n.delete(lv);
        // Peering into the basement: auto-hide every floor above so their slabs don't cover it.
        if (lv < 0) {
          for (const other of levels) if (other > lv) n.add(other);
        }
      } else {
        n.add(lv);
      }
      return n;
    });
    if (lv < 0 && hidden.has(lv)) setRoofOn(false);
  };

  const shown = model.floors.filter((f) => !hidden.has(f.level));
  const nav = useMemo(() => buildNav(model), [model]);
  const routes = useMemo(
    () => markers.map((m) => ({ marker: m, route: routeToMarker(nav, m) })).filter((r): r is { marker: Marker; route: Route } => !!r.route),
    [nav, markers],
  );
  const floorY = (f: Floor) => f.elevation + (exploded ? f.level * EXPLODE_GAP : 0);
  const top = model.floors.find((f) => f.level === topLevel)!;
  const showRoof = !!model.roof && roofOn && !hidden.has(topLevel);
  // Distance-sorted as hydrant-0, hydrant-1, … — beacon every mapped hydrant in the scene.
  const beaconHydrants = useMemo(() => {
    const list = model.compound?.features.filter((f) => f.kind === "hydrant") ?? [];
    return [...list].sort((a, b) => {
      const ia = Number(a.id.replace("hydrant-", "")) || 99;
      const ib = Number(b.id.replace("hydrant-", "")) || 99;
      return ia - ib;
    });
  }, [model.compound?.features]);
  const beaconHydrantIds = useMemo(() => new Set(beaconHydrants.map((f) => f.id)), [beaconHydrants]);
  // Basement open with ground floor gone → clear the yard/ground disc that sat on top of it.
  const peeringBasement = shown.some((f) => f.level < 0) && !shown.some((f) => f.level >= 0);

  // Frame the camera on the house, whatever its size.
  const { camPos, target, extent, minDist, maxDist, camNear, camFar, largeSite, rotateSpeed } = useMemo(() => {
    // Don't let distant hydrants/roads pull the camera to a city-block zoom — beacons then look like pins.
    const frameKinds = new Set(["yard", "garage", "shed", "neighbor", "driveway", "patio", "pool", "fence", "trees", "terrain"]);
    const pts = [
      ...model.floors.flatMap((f) => f.walls.flatMap((w) => [w.a, w.b])),
      ...(model.compound?.features
        .filter((f) => frameKinds.has(f.kind))
        .flatMap((f) => f.polygon) ?? []),
      ...model.footprint,
    ];
    const ext = Math.max(6, ...pts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const roomCount = model.floors.reduce((n, f) => n + f.rooms.length, 0);
    const large = ext > 35 || roomCount > 10;
    const height = top.elevation + top.height + (model.roof?.height ?? 0);
    const demR = demExtent(model.compound?.grade);
    const relief = demR ? Math.max(Math.abs(demR.min), Math.abs(demR.max), demR.max - demR.min) : 0;
    // Portrait screens see less width, so back the camera off further.
    const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
    const d = Math.min((ext * 2.0 + height + relief * 0.85) * (portrait ? 1.45 : 1), ext * 3.2 + 18 + relief);
    // Large compounds (neighbors, yard, street pads) need more pull-back than a single house.
    const maxD = Math.min(
      Math.max(ext * (large ? 6.8 : 4.2), d * (large ? 2.15 : 1.45), relief * 3.5 + 40),
      large ? 520 : 220,
    );
    const minD = Math.max(2.5, Math.min(large ? 10 : 6, ext * 0.15));
    // Start outside the front door looking in.
    const fy = streetFrontYaw(model);
    // Large extents need a wider near/far gap or depth buffer fights and orbit jitters.
    const near = Math.max(0.35, minD * 0.08);
    const far = Math.max(800, maxD * 12);
    return {
      camPos: [Math.sin(fy) * d * 0.95, d * 0.52, Math.cos(fy) * d * 0.95] as [number, number, number],
      target: [0, height * 0.35, 0] as [number, number, number],
      extent: ext,
      minDist: minD,
      maxDist: maxD,
      camNear: near,
      camFar: far,
      largeSite: large,
      // Slower rotate on big sites so drag doesn't feel twitchy.
      rotateSpeed: large ? Math.max(1.4, Math.min(2.6, 70 / ext)) : 3.4,
    };
  }, [model, top]);

  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    // Drag already moved the camera — only push angles when the HUD sliders changed.
    if (orbitFromDrag.current) {
      orbitFromDrag.current = false;
      return;
    }
    applyingOrbit.current = true;
    c.setAzimuthalAngle(frontYaw + orbitYaw);
    c.setPolarAngle(polarFromTilt(tiltAmt));
    c.update();
    applyingOrbit.current = false;
  }, [orbitYaw, tiltAmt, frontYaw]);

  // three-stdlib: dollyIn multiplies scale (use <1 to move closer); dollyOut divides.
  const zoomIn = () => {
    const c = controlsRef.current;
    if (!c) return;
    c.dollyIn(0.8);
    c.update();
  };
  const zoomOut = () => {
    const c = controlsRef.current;
    if (!c) return;
    c.dollyOut(0.8);
    c.update();
  };

  const footprintLine = useMemo(
    () => [...model.footprint, model.footprint[0]].map((p) => {
      const [x, z] = toXZ(p);
      return new THREE.Vector3(x, 0.11, z);
    }),
    [model.footprint],
  );

  const dropMarker = (floor: Floor) => (e: ThreeEvent<MouseEvent>) => {
    if (!tool) return;
    e.stopPropagation();
    setMarkers((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        type: tool,
        floor: floor.level,
        pos: [e.point.x, -e.point.z],
        note: "",
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  // Plain-English explanation shown above the toolbar on hover, focus, or tap.
  const HELP: Record<string, string> = {
    floor: "Show or hide this floor. Opening the basement hides floors above so you can look down into it.",
    roof: "Show or hide the roof. Turn it off to see straight down into the top floor.",
    hydrant: "Red sky beacons on every mapped fire hydrant nearby. Tap again to hide the POIs.",
    explode: "Pulls the floors apart vertically so you can see every level at once. Tap again to stack them back.",
    xray: "See-through mode: walls turn to outlines so you can spot exits (green) and stairs (yellow) through them.",
    markers: "Open the hazard tools. Pick one, then tap a room to pin it so everyone sees it.",
    fire: "Pin FIRE in a room. Tap the button, then tap the room.",
    victim: "Pin a PERSON who needs rescue in a room. Tap the button, then tap the room.",
    gas: "Pin a GAS hazard in a room. Tap the button, then tap the room.",
    shutoff: "Pin a utility SHUT-OFF (gas, power, water). Tap the button, then tap the room.",
  };
  const hint = (key: string) => ({
    onMouseEnter: () => setHelp(key),
    onMouseLeave: () => setHelp(null),
    onFocus: () => setHelp(key),
    onBlur: () => setHelp(null),
  });
  const helpText = help
    ? HELP[help]
    : tool
      ? `Tap a room to drop a ${MARKER_STYLE[tool].label.toLowerCase()} marker. Tap the button again to stop.`
      : "Hover or tap any button to see what it does. Drag to rotate, scroll or pinch to zoom.";

  const [wrapW, setWrapW] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const [cardPref, setCardPref] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem("cloudscan-card-open");
      if (v === "1" || v === "0") setCardPref(v === "1");
    } catch {}
  }, []);
  const narrowTop = wrapW > 0 && wrapW < 560;
  const cardOpen = cardPref ?? !narrowTop;
  // Room for icons/card + rotate/tilt bar + badge on one line? (px; generous so nothing ever touches)
  const barInline = wrapW >= (cardOpen ? 840 : 660);
  const cardScale = Math.max(0.75, Math.min(1, wrapW / 680 || 1));
  const toggleCard = () => {
    const next = !cardOpen;
    setCardPref(next);
    try {
      localStorage.setItem("cloudscan-card-open", next ? "1" : "0");
    } catch {}
  };

  const btn = (active: boolean) =>
    `shrink-0 border px-2.5 py-1.5 font-data text-[11px] transition ${
      active ? "border-bp-ink bg-bp-ink text-bp" : "border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"
    }`;

  return (
    // Layout: top-left home / download / arrow buttons with the CloudScan card directly underneath them, the
    // rotate/tilt bar and badge beside them, all overlaid on the map; the toolbar below in normal flow. The
    // rotate/tilt bar never shrinks; the card collapses upward behind the arrow. If the window is too small for everything, the whole
    // column scrolls so every button stays reachable.
    <div className="flex h-full w-full flex-col overflow-y-auto bg-bp">
      <div ref={wrap} className="relative min-h-[12rem] flex-1">
        <div
          className="pointer-events-none absolute inset-x-3 top-3 z-20 grid items-start gap-2"
          style={{
            // Badge always sits top right on the same line as the home button. The rotate/tilt bar joins that
            // line when there's room, otherwise it drops to its own line right below.
            gridTemplateColumns: "auto minmax(0, 1fr) auto",
            gridTemplateAreas: barInline ? '"left bar badge"' : '"left . badge" "bar bar bar"',
          }}
        >
          <div className="flex min-w-0 flex-col items-start gap-2" style={{ gridArea: "left" }}>
            <div className="flex gap-2">
              <Link href="/" className={iconBtn} aria-label="Home" title="Home">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 11.5 12 4l9 7.5" />
                  <path d="M5 10v10h14V10" />
                  <path d="M10 20v-6h4v6" />
                </svg>
              </Link>
              {onDownload && (
                <button type="button" onClick={onDownload} className={iconBtn} aria-label="Download model" title="Download model">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 4v11" />
                    <path d="m7 11 5 5 5-5" />
                    <path d="M5 20h14" />
                  </svg>
                </button>
              )}
              {card && (
                <button
                  type="button"
                  onClick={toggleCard}
                  aria-expanded={cardOpen}
                  aria-label={cardOpen ? "Hide CloudScan card" : "Show CloudScan card"}
                  title={cardOpen ? "Hide CloudScan card" : "Show CloudScan card"}
                  className={iconBtn}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                    style={{ transform: cardOpen ? "none" : "rotate(180deg)", transition: "transform 350ms cubic-bezier(.34,1.56,.64,1)" }}
                  >
                    <path d="M3 10l5-5 5 5" />
                  </svg>
                </button>
              )}
            </div>
            {card && <CardSlot open={cardOpen} scale={cardScale}>{card}</CardSlot>}
          </div>
    <div className="pointer-events-auto mx-auto flex max-w-full flex-wrap items-center justify-center gap-2 border border-bp-ink/60 bg-bp-deep px-3 py-2 text-bp-ink shadow-lg" style={{ gridArea: "bar" }}>
        <button
          type="button"
          className="border border-bp-ink/45 px-2.5 py-1 font-data text-sm font-semibold hover:bg-bp-ink/15"
          onClick={zoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="border border-bp-ink/45 px-2.5 py-1 font-data text-sm font-semibold hover:bg-bp-ink/15"
          onClick={zoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <label className="flex items-center gap-2 font-data text-[11px] text-bp-line">
          Rotate
          <input
            type="range"
            min={-Math.PI}
            max={Math.PI}
            step={0.01}
            value={orbitYaw}
            onChange={(e) => setOrbitYaw(Number(e.target.value))}
            className="h-1.5 w-24 cursor-pointer accent-bp-ink sm:w-32"
            aria-label="Rotate view (0 faces the front door)"
            title="0° = looking at the front door"
          />
        </label>
        <label className="flex items-center gap-2 font-data text-[11px] text-bp-line">
          Tilt
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={tiltAmt}
            onChange={(e) => setTiltAmt(Number(e.target.value))}
            className="h-1.5 w-24 cursor-pointer accent-bp-ink sm:w-28"
            aria-label="Tilt view (max is top-down)"
            title="Max = highest top-down view"
          />
        </label>
      </div>
      {badge && <div className="pointer-events-none shrink-0" style={{ gridArea: "badge" }}>{badge}</div>}
        </div>
      <Canvas
        camera={{ position: camPos, fov: 45, near: camNear, far: camFar }}
        shadows={false}
        gl={{ antialias: !largeSite, powerPreference: "high-performance", logarithmicDepthBuffer: true }}
        dpr={largeSite ? [1, 1.5] : [1, 2]}
        onCreated={() => requestAnimationFrame(() => requestAnimationFrame(() => onReady?.()))}
      >
        <color attach="background" args={[xray ? "#0b2e72" : "#0f3a8e"]} />
        {/* Keep fog beyond max orbit distance so zoom-out never whites out the house */}
        <fog attach="fog" args={[xray ? "#0b2e72" : "#0f3a8e", maxDist * 1.35, Math.max(camFar * 0.55, maxDist * 3.5)]} />
        <hemisphereLight args={["#ffffff", "#3a5fb0", 1.05]} />
        <directionalLight position={[extent * 2, extent * 3, extent * 1.5]} intensity={1.0} />
        <directionalLight position={[-extent * 2, extent, -extent * 2]} intensity={0.35} />

        <Line
          points={footprintLine}
          color="#eaf1ff"
          lineWidth={1.5}
          dashed
          dashSize={0.45}
          gapSize={0.3}
          transparent
          opacity={xray ? 0.9 : peeringBasement ? 0.35 : 0.75}
          raycast={noopRaycast}
          depthTest={!peeringBasement}
        />

        {(() => {
          const feats = model.compound?.features ?? [];
          const lotGrade = model.compound?.grade ?? null;
          const hasDem = !!lotGrade?.dem;
          // Outside lot/yard pad + base disc stay off — keep streets, pads, and structures.
          // No solid house pad (grid/DEM convey grade). With DEM, also skip coarse radius + neighbor pads.
          const noYard = feats.filter(
            (f) =>
              f.kind !== "yard" &&
              f.id !== "terrain-main" &&
              !(hasDem && f.id === "terrain-radius") &&
              !(hasDem && f.id.startsWith("terrain-nbr")),
          );
          // Draw terrain first so pads sit under structures.
          const ordered = [...noYard].sort((a, b) => Number(a.kind !== "terrain") - Number(b.kind !== "terrain"));
          const filtered = peeringBasement
            ? ordered.filter((f) => f.kind === "garage" || f.kind === "shed" || f.kind === "neighbor" || f.kind === "hydrant" || f.kind === "signal" || f.kind === "stop" || f.kind === "fence" || f.kind === "trees" || f.kind === "steps" || f.kind === "terrain")
            : largeSite
              ? ordered.filter((f) => f.kind !== "patio" && f.kind !== "pool")
              : ordered;
          return (
            <>
              {hasDem && lotGrade && (
                <DemTerrainMesh
                  grade={lotGrade}
                  footprint={model.footprint}
                  hovered={tip?.id === "terrain-dem"}
                  onOver={showTip}
                  onOut={hideTip}
                />
              )}
              {filtered.map((feature) => {
                // Beacon POIs replace the small meshes for the closest few when the toggle is on.
                if (hydrantBeaconOn && beaconHydrantIds.has(feature.id)) return null;
                return (
                  <SiteFeatureMesh
                    key={feature.id}
                    feature={feature}
                    hovered={tip?.id === feature.id}
                    onOver={showTip}
                    onOut={hideTip}
                    grade={lotGrade}
                  />
                );
              })}
            </>
          );
        })()}

        {hydrantBeaconOn &&
          beaconHydrants.map((feature, rank) => (
            <SiteFeatureMesh
              key={`beacon-${feature.id}`}
              feature={feature}
              beacon
              beaconRank={rank}
              grade={model.compound?.grade ?? null}
              hovered={tip?.id === feature.id}
              onOver={(e, id, title) =>
                showTip(
                  e,
                  id,
                  title,
                  rank === 0
                    ? "Closest mapped fire hydrant — primary water supply"
                    : `Hydrant #${rank + 1} by distance`,
                )
              }
              onOut={hideTip}
            />
          ))}

        {shown.map((floor) => (
          <group key={floor.level} position={[0, floorY(floor), 0]}>
            {largeSite || floor.rooms.length > 10 ? (
              <>
                <SimpleFloorDeck
                  floor={floor}
                  footprint={model.footprint}
                  xray={xray}
                  tipId={tip?.id ?? null}
                  onPick={(e, room) => {
                    if (!tool) return;
                    e.stopPropagation();
                    setMarkers((m) => [
                      ...m,
                      {
                        id: crypto.randomUUID(),
                        type: tool,
                        floor: floor.level,
                        pos: [e.point.x, -e.point.z],
                        note: room?.name ?? "",
                        createdAt: new Date().toISOString(),
                      },
                    ]);
                  }}
                  onOver={showTip}
                  onOut={hideTip}
                />
                {/* Keep stair pads visible on the merged deck — they were lost in the perf flatten. */}
                {floor.rooms
                  .filter((r) => r.type === "stair")
                  .map((room) => (
                    <RoomSlab
                      key={room.id}
                      room={room}
                      floorName={floor.name}
                      xray={xray}
                      showLabel
                      y={0.14}
                      onPick={dropMarker(floor)}
                      onOver={showTip}
                      onOut={hideTip}
                    />
                  ))}
              </>
            ) : (
              floor.rooms.map((room) => (
                <RoomSlab
                  key={room.id}
                  room={room}
                  floorName={floor.name}
                  xray={xray}
                  showLabel={shown.length === 1 || exploded || room.type === "stair"}
                  onPick={dropMarker(floor)}
                  onOver={showTip}
                  onOut={hideTip}
                />
              ))
            )}
            {floor.walls.map((wall) => (
              <WallMesh key={wall.id} wall={wall} floor={floor} xray={xray} passPointer={!tool} assumed={assumed} />
            ))}
            {markers
              .filter((m) => m.floor === floor.level)
              .map((m) => (
                <MarkerPin key={m.id} marker={m} onDelete={(id) => { document.body.style.cursor = ""; setMarkers((all) => all.filter((x) => x.id !== id)); }} />
              ))}
          </group>
        ))}

        {routes.map(({ marker, route }) => {
          // Break the line wherever a floor is hidden so it never floats in empty space.
          const runs: THREE.Vector3[][] = [[]];
          for (const n of route.nodes) {
            const floor = model.floors.find((f) => f.level === n.level);
            if (!floor || hidden.has(n.level)) { runs.push([]); continue; }
            const [x, z] = toXZ(n.pt);
            runs[runs.length - 1].push(new THREE.Vector3(x, floorY(floor) + 0.2, z));
          }
          return runs
            .filter((pts) => pts.length > 1)
            .map((pts, i) => (
              <Line
                key={`${marker.id}-${i}`}
                points={pts}
                color={MARKER_STYLE[marker.type].color}
                lineWidth={3}
                dashed
                dashSize={route.estimated ? 0.15 : 0.25}
                gapSize={route.estimated ? 0.3 : 0.2}
                depthTest={false}
                renderOrder={20}
                raycast={noopRaycast}
              />
            ));
        })}

        {showRoof && (
          <RoofMesh roof={model.roof!} footprint={model.footprint} baseY={floorY(top) + top.height} xray={xray} />
        )}

        <TerrainGrid
          grade={model.compound?.grade ?? null}
          size={siteReach(model.footprint) * 2}
          divisions={Math.max(20, Math.min(40, Math.round(siteReach(model.footprint) / 6)))}
        />
        <OrbitControls
          ref={controlsRef}
          makeDefault
          target={target}
          maxPolarAngle={MAX_POLAR}
          minPolarAngle={MIN_POLAR}
          minDistance={minDist}
          maxDistance={maxDist}
          enableDamping={false}
          rotateSpeed={rotateSpeed}
          zoomSpeed={largeSite ? 1.1 : 1.35}
          panSpeed={largeSite ? 1.1 : 1.4}
          onStart={() => setTip(null)}
          onChange={() => {
            const c = controlsRef.current;
            if (!c || applyingOrbit.current) return;
            orbitFromDrag.current = true;
            setOrbitYaw(wrapPi(c.getAzimuthalAngle() - frontYaw));
            setTiltAmt(Math.min(1, Math.max(0, tiltFromPolar(c.getPolarAngle()))));
          }}
        />
      </Canvas>

      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[11rem] border border-bp-ink/60 bg-bp-deep px-2.5 py-1.5 text-bp-ink"
          style={{ left: tip.x, top: tip.y }}
        >
          <div className="font-data text-xs leading-snug">{tip.title}</div>
          <div className="font-data text-[11px] leading-snug text-bp-line">{tip.detail}</div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 hidden flex-col gap-1.5 font-data text-[11px] text-bp-line sm:flex">
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#eaf1ff" strokeWidth="2" /></svg>
          {assumed ? "from the map" : "from your plan"}
        </span>
        {assumed && (
          <span className="flex items-center gap-2">
            <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#9ebcff" strokeWidth="2" strokeDasharray="4 3" /></svg>
            estimated inside
          </span>
        )}
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#ff8a6b" strokeWidth="2" /></svg>
          exits and stairs
        </span>
      </div>

      </div>

      <div className="flex shrink-0 flex-col items-center gap-1.5 px-3 pb-3 pt-2">
        <div
          role="status"
          aria-live="polite"
          className={`max-w-xl border px-3 py-1.5 text-center font-data text-xs leading-snug ${
            tool ? "border-bp-ink bg-bp-deep text-bp-ink" : "border-bp-ink/40 bg-bp-deep/90 text-bp-line"
          }`}
        >
          {helpText}
        </div>
        <div className="flex max-w-full flex-wrap items-end gap-x-3 gap-y-2 border border-bp-ink/60 bg-bp-deep p-1.5">
          <div className="flex max-w-full flex-col gap-1">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">Floors</span>
            <div className="flex flex-wrap gap-1.5">
              {levels.map((lv) => (
                <button
                  key={lv}
                  className={btn(!hidden.has(lv))}
                  onClick={() => toggleFloor(lv)}
                  aria-pressed={!hidden.has(lv)}
                  aria-label={`${model.floors.find((f) => f.level === lv)?.name} floor: ${hidden.has(lv) ? "hidden, tap to show" : "shown, tap to hide"}`}
                  {...hint("floor")}
                >
                  {model.floors.find((f) => f.level === lv)?.name}
                </button>
              ))}
              {model.roof && (
                <button className={btn(roofOn)} onClick={() => setRoofOn((v) => !v)} aria-pressed={roofOn} {...hint("roof")}>
                  Roof
                </button>
              )}
            </div>
          </div>
          <div className="flex max-w-full flex-col gap-1 border-l border-bp-ink/30 pl-3">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">View</span>
            <div className="flex flex-wrap gap-1.5">
              <button className={btn(exploded)} onClick={() => setExploded((v) => !v)} aria-pressed={exploded} {...hint("explode")}>
                Spread floors apart
              </button>
              <button className={btn(xray)} onClick={() => setXray((v) => !v)} aria-pressed={xray} {...hint("xray")}>
                See through walls
              </button>
              {beaconHydrants.length > 0 && (
                <button
                  className={btn(hydrantBeaconOn)}
                  onClick={() => setHydrantBeaconOn((v) => !v)}
                  aria-pressed={hydrantBeaconOn}
                  style={hydrantBeaconOn ? { background: "#dc2626", color: "#fff", borderColor: "#fecaca" } : undefined}
                  {...hint("hydrant")}
                >
                  Hydrant beacons ({beaconHydrants.length})
                </button>
              )}
            </div>
          </div>
          <div className="flex max-w-full flex-col gap-1 border-l border-bp-ink/30 pl-3">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">Mark hazards</span>
            <div className="flex flex-wrap gap-1.5">
              <button className={btn(marksOpen || !!tool)} onClick={() => setMarksOpen((v) => !v)} aria-pressed={marksOpen} {...hint("markers")}>
                {marksOpen ? "Hide tools" : "Add a marker"}
              </button>
              {marksOpen &&
                (["fire", "victim", "gas", "shutoff"] as MarkerType[]).map((t) => (
                  <button
                    key={t}
                    className={btn(tool === t)}
                    style={tool === t ? { background: MARKER_STYLE[t].color, color: "#111" } : undefined}
                    onClick={() => setTool((cur) => (cur === t ? null : t))}
                    aria-pressed={tool === t}
                    {...hint(t)}
                  >
                    {MARKER_STYLE[t].label}
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
