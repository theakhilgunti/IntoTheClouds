"use client";

import { useMemo, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type {
  BuildingModel,
  Floor,
  Marker,
  MarkerType,
  Point,
  Roof,
  Room,
  Wall,
} from "@/packages/schema/building-model";
// Model frame: x = east, y = north. Three.js frame: x = east, y = up, z = south.
const toXZ = ([x, y]: Point): [number, number] => [x, -y];

function LabelSprite({
  text,
  color,
  textColor = "#111111",
  scale = [1.8, 0.45, 1] as [number, number, number],
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = textColor;
    ctx.font = "bold 64px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const map = new THREE.CanvasTexture(canvas);
    map.needsUpdate = true;
    return map;
  }, [text, color, textColor]);
  if (!texture) return null;
  return (
    <sprite scale={scale}>
      <spriteMaterial map={texture} transparent />
    </sprite>
  );
}

const ROOM_COLORS: Record<Room["type"], string> = {
  living: "#3b4252",
  kitchen: "#4c3b2a",
  dining: "#3d4a3a",
  bedroom: "#2e3a4d",
  bathroom: "#2a4448",
  hallway: "#383838",
  stair: "#facc15",
  garage: "#333333",
  utility: "#7f1d1d",
  closet: "#333333",
  office: "#2e3a4d",
  basement: "#2b2b2b",
  other: "#333333",
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

function WallMesh({ wall, floor, xray }: { wall: Wall; floor: Floor; xray: boolean }) {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 0.01) return null;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const angle = Math.atan2(by - ay, bx - ax);
  const color = xray ? (wall.exterior ? "#ef4444" : "#facc15") : wall.exterior ? "#e4ddd0" : "#b6bcc6";
  const showWindows = !xray && wall.exterior && floor.level >= 0;
  const doors = floor.doors.filter((d) => d.wallId === wall.id);

  return (
    <>
      {wallSegments(wall, floor).map(([s, e], i) => {
        const mid = (s + e) / 2;
        const [x, z] = toXZ([ax + ux * mid, ay + uy * mid]);
        const segLen = e - s;
        const nWin = showWindows ? Math.floor((segLen - 0.8) / 2.4) : 0;
        return (
          <group key={i} position={[x, floor.height / 2, z]} rotation={[0, angle, 0]}>
            <mesh>
              <boxGeometry args={[segLen, floor.height, wall.thickness]} />
              <meshStandardMaterial
                color={color}
                wireframe={xray}
                transparent={xray || !wall.exterior}
                opacity={xray ? 0.9 : wall.exterior ? 1 : 0.92}
              />
            </mesh>
            {Array.from({ length: nWin }, (_, k) => {
              const off = -segLen / 2 + (segLen / (nWin + 1)) * (k + 1);
              return (
                <mesh key={k} position={[off, 0.25, 0]}>
                  <boxGeometry args={[0.95, 1.25, wall.thickness + 0.04]} />
                  <meshStandardMaterial color="#1f3b57" emissive="#0b1d2e" roughness={0.2} metalness={0.3} />
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
            <mesh key={d.id} position={[x, h / 2, z]} rotation={[0, angle, 0]}>
              <boxGeometry args={[d.width, h, wall.thickness * 0.5]} />
              <meshStandardMaterial
                color={xray ? "#22c55e" : "#6b3a1f"}
                emissive={xray ? "#22c55e" : "#000000"}
                emissiveIntensity={xray ? 0.9 : 0}
                transparent={xray}
                opacity={xray ? 0.75 : 1}
              />
            </mesh>
          );
        })}
    </>
  );
}

function RoomSlab({
  room,
  xray,
  showLabel,
  onPick,
}: {
  room: Room;
  xray: boolean;
  showLabel: boolean;
  onPick: (e: ThreeEvent<MouseEvent>) => void;
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
      <mesh geometry={geom} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} onClick={onPick}>
        <meshStandardMaterial
          color={xray && !isStair ? "#111111" : ROOM_COLORS[room.type]}
          emissive={isStair ? "#facc15" : "#000000"}
          emissiveIntensity={isStair ? (xray ? 0.8 : 0.3) : 0}
          side={THREE.DoubleSide}
        />
      </mesh>
      {showLabel && (
        <group position={[center[0], 0.45, center[1]]}>
          <LabelSprite text={room.name} color="#111111" textColor="#ffffff" />
        </group>
      )}
    </group>
  );
}

/** Roof geometry for an oriented rectangle. Ridge runs along the longer side. */
function RoofMesh({ roof, baseY, xray }: { roof: Roof; baseY: number; xray: boolean }) {
  const overhang = roof.shape === "flat" ? 0.1 : 0.45;
  const W = roof.width + overhang * 2;
  const D = roof.depth + overhang * 2;
  const ridgeAlongWidth = W >= D;
  const span = ridgeAlongWidth ? D : W;
  const length = ridgeAlongWidth ? W : D;
  const h = roof.height;

  const geometry = useMemo(() => {
    const s = span / 2;
    switch (roof.shape) {
      case "flat":
        return new THREE.BoxGeometry(span, h, length).translate(0, h / 2, 0);
      case "hip": {
        const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
        return g.scale(span, h, length).translate(0, h / 2, 0);
      }
      case "mansard": {
        const g = new THREE.CylinderGeometry(Math.SQRT1_2 * 0.62, Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
        return g.scale(span, h, length).translate(0, h / 2, 0);
      }
      case "gambrel": {
        const shape = new THREE.Shape([
          new THREE.Vector2(-s, 0), new THREE.Vector2(s, 0), new THREE.Vector2(s * 0.62, h * 0.62),
          new THREE.Vector2(0, h), new THREE.Vector2(-s * 0.62, h * 0.62),
        ]);
        return new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }).translate(0, 0, -length / 2);
      }
      default: {
        const shape = new THREE.Shape([new THREE.Vector2(-s, 0), new THREE.Vector2(s, 0), new THREE.Vector2(0, h)]);
        return new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }).translate(0, 0, -length / 2);
      }
    }
  }, [roof.shape, span, length, h]);

  const [x, z] = toXZ(roof.center);
  return (
    <group position={[x, baseY, z]} rotation={[0, roof.rotation, 0]}>
      <mesh geometry={geometry} rotation={[0, ridgeAlongWidth ? Math.PI / 2 : 0, 0]}>
        <meshStandardMaterial
          color={xray ? "#ef4444" : "#4a4f57"}
          wireframe={xray}
          transparent={xray}
          opacity={xray ? 0.35 : 1}
          roughness={0.9}
          side={THREE.DoubleSide}
        />
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

export default function Viewer({ model }: { model: BuildingModel }) {
  const levels = model.floors.map((f) => f.level);
  const topLevel = Math.max(...levels);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [exploded, setExploded] = useState(false);
  const [xray, setXray] = useState(false);
  const [roofOn, setRoofOn] = useState(true);
  const [tool, setTool] = useState<MarkerType | null>(null);
  const [markers, setMarkers] = useState<Marker[]>(model.markers);

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
    const pts = model.floors.flatMap((f) => f.walls.flatMap((w) => [w.a, w.b]));
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
      return new THREE.Vector3(x, 0.03, z);
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

  const btn = (active: boolean) =>
    `min-h-11 min-w-11 rounded-lg px-3 text-xs font-bold uppercase tracking-wide transition sm:text-sm ${
      active ? "bg-yellow-400 text-black" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
    }`;

  return (
    <div className="relative h-full w-full bg-neutral-950">
      <Canvas camera={{ position: camPos, fov: 45, near: 0.1, far: 1000 }} shadows={false}>
        <color attach="background" args={[xray ? "#050505" : "#0d1420"]} />
        <hemisphereLight args={["#dbe7ff", "#2a2a2a", 0.9]} />
        <directionalLight position={[extent * 2, extent * 3, extent * 1.5]} intensity={1.3} />
        <directionalLight position={[-extent * 2, extent, -extent * 2]} intensity={0.35} />

        {!xray && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
            <circleGeometry args={[extent * 3, 48]} />
            <meshStandardMaterial color="#1c2a1f" transparent opacity={hidden.size || exploded ? 0.35 : 0.85} />
          </mesh>
        )}
        <Line points={footprintLine} color="#facc15" lineWidth={1.5} transparent opacity={xray ? 0.9 : 0.5} />

        {shown.map((floor) => (
          <group key={floor.level} position={[0, floorY(floor), 0]}>
            {floor.rooms.map((room) => (
              <RoomSlab
                key={room.id}
                room={room}
                xray={xray}
                showLabel={shown.length === 1 || exploded}
                onPick={dropMarker(floor)}
              />
            ))}
            {floor.walls.map((wall) => (
              <WallMesh key={wall.id} wall={wall} floor={floor} xray={xray} />
            ))}
            {markers
              .filter((m) => m.floor === floor.level)
              .map((m) => (
                <MarkerPin key={m.id} marker={m} />
              ))}
          </group>
        ))}

        {showRoof && <RoofMesh roof={model.roof!} baseY={floorY(top) + top.height} xray={xray} />}

        <gridHelper args={[extent * 6, Math.round(extent * 3), "#333", "#1a1a1a"]} position={[0, -2.7, 0]} />
        <OrbitControls makeDefault target={target} maxPolarAngle={Math.PI * 0.49} minDistance={4} maxDistance={extent * 8} />
      </Canvas>

      <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-2 bg-black/80 p-3 backdrop-blur">
        {levels.map((lv) => (
          <button
            key={lv}
            className={btn(!hidden.has(lv))}
            onClick={() => toggleFloor(lv)}
            aria-pressed={!hidden.has(lv)}
            title={hidden.has(lv) ? "Show this floor" : "Hide this floor"}
          >
            {model.floors.find((f) => f.level === lv)?.name}
          </button>
        ))}
        {model.roof && (
          <button className={btn(roofOn)} onClick={() => setRoofOn((v) => !v)} aria-pressed={roofOn}>
            Roof
          </button>
        )}
        <span className="mx-1 hidden w-px bg-neutral-700 sm:block" />
        <button className={btn(exploded)} onClick={() => setExploded((v) => !v)} aria-pressed={exploded}>
          Explode
        </button>
        <button className={btn(xray)} onClick={() => setXray((v) => !v)} aria-pressed={xray}>
          X-ray
        </button>
        <span className="mx-1 hidden w-px bg-neutral-700 sm:block" />
        {(["fire", "victim", "gas", "shutoff"] as MarkerType[]).map((t) => (
          <button
            key={t}
            className={btn(tool === t)}
            style={tool === t ? { background: MARKER_STYLE[t].color } : undefined}
            onClick={() => setTool((cur) => (cur === t ? null : t))}
            aria-pressed={tool === t}
          >
            + {MARKER_STYLE[t].label}
          </button>
        ))}
      </div>
      {tool && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center">
          <span className="rounded-full bg-black/80 px-4 py-1.5 text-sm text-white">
            Tap a room to drop a {MARKER_STYLE[tool].label.toLowerCase()} marker
          </span>
        </div>
      )}
    </div>
  );
}
