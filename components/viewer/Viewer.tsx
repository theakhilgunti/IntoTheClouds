"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Edges, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type {
  BuildingModel,
  CompoundFeature,
  Floor,
  Marker,
  MarkerType,
  Point,
  Roof,
  Room,
  Wall,
} from "@/packages/schema/building-model";
import { buildRoofPositions, type Pt } from "@/lib/roof-geom";
// Model frame: x = east, y = north. Three.js frame: x = east, y = up, z = south.
const toXZ = ([x, y]: Point): [number, number] => [x, -y];

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
  other: "Room",
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
};

const SITE_NOTE: Record<CompoundFeature["source"], string> = {
  map: "From the map",
  aerial: "From the aerial photo",
  parcel: "City tax lot",
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

/** Split a wall into solid segments around its door openings. */
function wallSegments(wall: Wall, floor: Floor): Array<[number, number]> {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const len = Math.hypot(bx - ax, by - ay);
  const gaps = floor.doors
    .filter((d) => d.wallId === wall.id)
    .map((d) => [Math.max(0, d.t * len - d.width / 2), Math.min(len, d.t * len + d.width / 2)] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const segs: Array<[number, number]> = [];
  let cur = 0;
  for (const [s, e] of gaps) {
    if (s > cur) segs.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < len) segs.push([cur, len]);
  return segs;
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
              {!xray && <Edges color={edge} threshold={15} raycast={noopRaycast} />}
            </mesh>
            {Array.from({ length: nWin }, (_, k) => {
              const off = -segLen / 2 + (segLen / (nWin + 1)) * (k + 1);
              return (
                <mesh key={k} position={[off, winY, 0]} raycast={raycast}>
                  <boxGeometry args={[Math.min(0.95, segLen * 0.42), winH, wall.thickness + 0.04]} />
                  <meshStandardMaterial color="#0f3a8e" transparent opacity={0.85} />
                  <Edges color="#0b2e72" raycast={noopRaycast} />
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
              {!xray && <Edges color="#7a2e18" raycast={noopRaycast} />}
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
  hovered,
  onPick,
  onOver,
  onOut,
}: {
  room: Room;
  floorName: string;
  xray: boolean;
  showLabel: boolean;
  hovered: boolean;
  onPick: (e: ThreeEvent<MouseEvent>) => void;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
}) {
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
        position={[0, 0.04, 0]}
        onClick={onPick}
        onPointerOver={(e) => {
          e.stopPropagation();
          onOver(e, room.id, room.name, `${floorName} · ${ROOM_WORDS[room.type]}`);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onOut(room.id);
        }}
      >
        <meshStandardMaterial
          color={xray && !isStair ? "#0b2e72" : ROOM_COLORS[room.type]}
          emissive={hovered ? "#ffffff" : isStair ? "#ff8a6b" : "#000000"}
          emissiveIntensity={hovered ? 0.35 : isStair ? (xray ? 0.8 : 0.3) : 0}
          side={THREE.DoubleSide}
        />
      </mesh>
      {(showLabel || hovered) && (
        <group position={[center[0], 0.7, center[1]]}>
          <LabelSprite text={room.name} color="#0b2e72" fit />
        </group>
      )}
    </group>
  );
}

/** Stack ground surfaces so large lots do not z-fight. */
const LAYER_Y: Record<string, number> = {
  base: -0.22,
  yard: 0.0,
  road: 0.05,
  driveway: 0.07,
  patio: 0.09,
  pool: 0.06,
  fence: 0.0,
};

function groundMat(color: string, hovered: boolean, opts?: { transparent?: boolean; opacity?: number; offset?: number }) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={hovered ? "#ffffff" : "#000000"}
      emissiveIntensity={hovered ? 0.25 : 0}
      roughness={0.95}
      transparent={opts?.transparent}
      opacity={opts?.opacity ?? 1}
      side={THREE.DoubleSide}
      depthWrite={!(opts?.transparent && (opts.opacity ?? 1) < 1)}
      polygonOffset
      polygonOffsetFactor={opts?.offset ?? -1}
      polygonOffsetUnits={opts?.offset ?? -1}
    />
  );
}

/** Garage / shed: wall ring + simple gable roof instead of a solid cheese block. */
function OutbuildingMesh({
  feature,
  hovered,
  onOver,
  onOut,
}: {
  feature: CompoundFeature;
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
}) {
  const wallH = Math.max(2.2, feature.height || 2.6);
  const roofH = Math.min(2.2, Math.max(1.1, wallH * 0.35));
  const walls = useMemo(() => {
    const ring = feature.polygon;
    const out: { key: string; pos: [number, number, number]; rot: number; len: number }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.15) continue;
      const [x, z] = toXZ([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      out.push({ key: `${i}`, pos: [x, wallH / 2, z], rot: Math.atan2(b[1] - a[1], b[0] - a[0]), len });
    }
    return out;
  }, [feature.polygon, wallH]);
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <shapeGeometry args={[new THREE.Shape(feature.polygon.map(([x, y]) => new THREE.Vector2(x, y)))]} />
        <meshStandardMaterial color="#2a5ab8" roughness={1} />
      </mesh>
      {roofGeo && (
        <group position={[0, wallH, 0]}>
          <mesh geometry={roofGeo} raycast={noopRaycast}>
            <meshStandardMaterial color="#1c3f86" roughness={0.9} side={THREE.DoubleSide} />
            <Edges color="#eaf1ff" threshold={20} raycast={noopRaycast} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function SiteFeatureMesh({
  feature,
  hovered,
  onOver,
  onOut,
}: {
  feature: CompoundFeature;
  hovered: boolean;
  onOver: (e: ThreeEvent<PointerEvent>, id: string, title: string, detail: string) => void;
  onOut: (id: string) => void;
}) {
  const center = useMemo(() => {
    const n = feature.polygon.length || 1;
    const c = feature.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Point, [0, 0] as Point);
    return toXZ([c[0] / n, c[1] / n]);
  }, [feature.polygon]);

  const slabY =
    feature.kind === "yard"
      ? LAYER_Y.yard
      : feature.kind === "road"
        ? LAYER_Y.road
        : feature.kind === "driveway"
          ? LAYER_Y.driveway
          : feature.kind === "patio"
            ? LAYER_Y.patio
            : feature.kind === "pool"
              ? LAYER_Y.pool
              : LAYER_Y.fence;
  const thickness =
    feature.kind === "fence"
      ? Math.max(0.8, feature.height)
      : feature.kind === "yard"
        ? 0.045
        : feature.kind === "pool"
          ? 0.12
          : feature.kind === "road"
            ? 0.07
            : 0.055;

  const slabGeo = useMemo(() => {
    if (feature.kind === "trees" || feature.kind === "garage" || feature.kind === "shed") return null;
    const shape = new THREE.Shape(feature.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return g;
  }, [feature.kind, feature.polygon, feature.height, thickness]);

  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onOver(e, feature.id, feature.label, SITE_NOTE[feature.source]);
  };

  if (feature.kind === "trees") {
    return (
      <group position={[center[0], 0, center[1]]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
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

  if (feature.kind === "garage" || feature.kind === "shed") {
    return <OutbuildingMesh feature={feature} hovered={hovered} onOver={onOver} onOut={onOut} />;
  }

  if (!slabGeo) return null;
  const offset = feature.kind === "yard" ? -4 : feature.kind === "road" ? -3 : feature.kind === "driveway" ? -2 : -1;
  return (
    <mesh geometry={slabGeo} position={[0, slabY, 0]} onPointerOver={hover} onPointerOut={() => onOut(feature.id)}>
      {groundMat(SITE_COLOR[feature.kind], hovered, {
        transparent: feature.kind === "pool",
        opacity: feature.kind === "pool" ? 0.88 : 1,
        offset,
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
  if (!geometry.framed) {
    return (
      <group position={[0, baseY, 0]}>
        <mesh geometry={geometry.geo} raycast={noopRaycast}>
          <meshStandardMaterial
            color={xray ? "#9ebcff" : "#1c3f86"}
            wireframe={xray}
            transparent={xray}
            opacity={xray ? 0.35 : 1}
            roughness={0.9}
            side={THREE.DoubleSide}
          />
          {!xray && <Edges color="#eaf1ff" threshold={20} raycast={noopRaycast} />}
        </mesh>
      </group>
    );
  }
  const [x, z] = toXZ(roof.center);
  return (
    <group position={[x, baseY, z]} rotation={[0, roof.rotation, 0]}>
      <mesh geometry={geometry.geo} raycast={noopRaycast}>
        <meshStandardMaterial
          color={xray ? "#9ebcff" : "#1c3f86"}
          wireframe={xray}
          transparent={xray}
          opacity={xray ? 0.35 : 1}
          roughness={0.9}
          side={THREE.DoubleSide}
        />
        {!xray && <Edges color="#eaf1ff" threshold={20} raycast={noopRaycast} />}
      </mesh>
    </group>
  );
}

function MarkerPin({ marker }: { marker: Marker }) {
  const style = MARKER_STYLE[marker.type];
  const [x, z] = toXZ(marker.pos);
  return (
    <group position={[x, 0, z]}>
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

export default function Viewer({ model, onReady }: { model: BuildingModel; onReady?: () => void }) {
  const levels = model.floors.map((f) => f.level);
  const topLevel = Math.max(...levels);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [exploded, setExploded] = useState(false);
  const [xray, setXray] = useState(false);
  const [roofOn, setRoofOn] = useState(true);
  const [tool, setTool] = useState<MarkerType | null>(null);
  const [marksOpen, setMarksOpen] = useState(false);
  const [help, setHelp] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>(model.markers);
  const assumed = model.interior?.status !== "verified";
  const wrap = useRef<HTMLDivElement>(null);
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

  const toggleFloor = (lv: number) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(lv)) n.delete(lv);
      else n.add(lv);
      return n;
    });

  const shown = model.floors.filter((f) => !hidden.has(f.level));
  const floorY = (f: Floor) => f.elevation + (exploded ? f.level * EXPLODE_GAP : 0);
  const top = model.floors.find((f) => f.level === topLevel)!;
  const showRoof = !!model.roof && roofOn && !hidden.has(topLevel);

  // Frame the camera on the house, whatever its size.
  const { camPos, target, extent } = useMemo(() => {
    const pts = [
      ...model.floors.flatMap((f) => f.walls.flatMap((w) => [w.a, w.b])),
      ...(model.compound?.features.flatMap((f) => f.polygon) ?? []),
    ];
    const ext = Math.max(6, ...pts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const height = top.elevation + top.height + (model.roof?.height ?? 0);
    // Portrait screens see less width, so back the camera off further.
    const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
    const d = (ext * 2.2 + height) * (portrait ? 1.6 : 1);
    return {
      camPos: [d * 0.75, d * 0.62, d * 0.85] as [number, number, number],
      target: [0, height * 0.35, 0] as [number, number, number],
      extent: ext,
    };
  }, [model, top]);

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
    floor: "Show or hide this floor. Hide the upper floors to look at the one below.",
    roof: "Show or hide the roof. Turn it off to see straight down into the top floor.",
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

  const btn = (active: boolean) =>
    `shrink-0 border px-2.5 py-1.5 font-data text-[11px] transition ${
      active ? "border-bp-ink bg-bp-ink text-bp" : "border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"
    }`;

  return (
    <div ref={wrap} className="relative h-full w-full bg-bp">
      <Canvas
        camera={{ position: camPos, fov: 45, near: 0.1, far: 1000 }}
        shadows={false}
        onCreated={() => requestAnimationFrame(() => requestAnimationFrame(() => onReady?.()))}
      >
        <color attach="background" args={[xray ? "#0b2e72" : "#0f3a8e"]} />
        <fog attach="fog" args={[xray ? "#0b2e72" : "#0f3a8e", extent * 5, extent * 13]} />
        <hemisphereLight args={["#ffffff", "#3a5fb0", 1.05]} />
        <directionalLight position={[extent * 2, extent * 3, extent * 1.5]} intensity={1.0} />
        <directionalLight position={[-extent * 2, extent, -extent * 2]} intensity={0.35} />

        {!xray && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, LAYER_Y.base, 0]} raycast={noopRaycast}>
            <circleGeometry args={[extent * 3, 48]} />
            <meshStandardMaterial
              color="#0d3482"
              transparent
              opacity={hidden.size || exploded ? 0.35 : 0.8}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-8}
              polygonOffsetUnits={-8}
            />
          </mesh>
        )}
        <Line points={footprintLine} color="#eaf1ff" lineWidth={1.5} dashed dashSize={0.45} gapSize={0.3} transparent opacity={xray ? 0.9 : 0.75} raycast={noopRaycast} />

        {model.compound?.features.map((feature) => (
          <SiteFeatureMesh
            key={feature.id}
            feature={feature}
            hovered={tip?.id === feature.id}
            onOver={showTip}
            onOut={hideTip}
          />
        ))}

        {shown.map((floor) => (
          <group key={floor.level} position={[0, floorY(floor), 0]}>
            {floor.rooms.map((room) => (
              <RoomSlab
                key={room.id}
                room={room}
                floorName={floor.name}
                xray={xray}
                showLabel={shown.length === 1 || exploded}
                hovered={tip?.id === room.id}
                onPick={dropMarker(floor)}
                onOver={showTip}
                onOut={hideTip}
              />
            ))}
            {floor.walls.map((wall) => (
              <WallMesh key={wall.id} wall={wall} floor={floor} xray={xray} passPointer={!tool} assumed={assumed} />
            ))}
            {markers
              .filter((m) => m.floor === floor.level)
              .map((m) => (
                <MarkerPin key={m.id} marker={m} />
              ))}
          </group>
        ))}

        {showRoof && (
          <RoofMesh roof={model.roof!} footprint={model.footprint} baseY={floorY(top) + top.height} xray={xray} />
        )}

        <gridHelper args={[extent * 6, Math.round(extent * 3), "#4a78d0", "#2a55b0"]} position={[0, -2.7, 0]} />
        <OrbitControls
          makeDefault
          target={target}
          maxPolarAngle={Math.PI * 0.49}
          minDistance={4}
          maxDistance={extent * 8}
          onStart={() => setTip(null)}
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

      <div className="pointer-events-none absolute bottom-36 left-3 hidden flex-col gap-1.5 font-data text-[11px] text-bp-line sm:flex">
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

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-1.5 px-3">
        <div
          role="status"
          aria-live="polite"
          className={`max-w-xl border px-3 py-1.5 text-center font-data text-xs leading-snug ${
            tool ? "border-bp-ink bg-bp-deep text-bp-ink" : "border-bp-ink/40 bg-bp-deep/90 text-bp-line"
          }`}
        >
          {helpText}
        </div>
        <div className="pointer-events-auto flex max-w-full items-end gap-3 overflow-x-auto border border-bp-ink/60 bg-bp-deep p-1.5">
          <div className="flex shrink-0 flex-col gap-1">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">Floors</span>
            <div className="flex gap-1.5">
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
          <div className="flex shrink-0 flex-col gap-1 border-l border-bp-ink/30 pl-3">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">View</span>
            <div className="flex gap-1.5">
              <button className={btn(exploded)} onClick={() => setExploded((v) => !v)} aria-pressed={exploded} {...hint("explode")}>
                Spread floors apart
              </button>
              <button className={btn(xray)} onClick={() => setXray((v) => !v)} aria-pressed={xray} {...hint("xray")}>
                See through walls
              </button>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-1 border-l border-bp-ink/30 pl-3">
            <span className="px-0.5 font-data text-[9px] uppercase tracking-widest text-bp-line">Mark hazards</span>
            <div className="flex gap-1.5">
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
