"use client";

import { useMemo, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type {
  BuildingModel,
  Floor,
  Marker,
  MarkerType,
  Point,
  Room,
  Wall,
} from "@/packages/schema/building-model";

// Model frame: x = east, y = north. Three.js frame: x = east, y = up, z = south.
const toXZ = ([x, y]: Point): [number, number] => [x, -y];

const ROOM_COLORS: Record<Room["type"], string> = {
  living: "#3b4252",
  kitchen: "#4c3b2a",
  dining: "#3b4252",
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
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const angle = Math.atan2(by - ay, bx - ax);
  const color = xray ? (wall.exterior ? "#ef4444" : "#facc15") : wall.exterior ? "#cbd5e1" : "#94a3b8";
  return (
    <>
      {wallSegments(wall, floor).map(([s, e], i) => {
        const mid = (s + e) / 2;
        const [x, z] = toXZ([ax + ux * mid, ay + uy * mid]);
        return (
          <mesh key={i} position={[x, floor.height / 2, z]} rotation={[0, angle, 0]}>
            <boxGeometry args={[e - s, floor.height, wall.thickness]} />
            <meshStandardMaterial
              color={color}
              wireframe={xray}
              transparent
              opacity={xray ? 0.9 : wall.exterior ? 0.35 : 0.85}
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
        <Html position={[center[0], 0.4, center[1]]} center distanceFactor={14}>
          <div className="pointer-events-none whitespace-nowrap rounded bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
            {room.name}
          </div>
        </Html>
      )}
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
      <Html position={[0, 1.6, 0]} center distanceFactor={14}>
        <div
          className="pointer-events-none rounded px-2 py-0.5 text-xs font-black text-black"
          style={{ background: style.color }}
        >
          {style.label}
        </div>
      </Html>
    </group>
  );
}

export default function Viewer({ model }: { model: BuildingModel }) {
  const levels = model.floors.map((f) => f.level);
  const [visible, setVisible] = useState<number | "all">("all");
  const [exploded, setExploded] = useState(false);
  const [xray, setXray] = useState(true);
  const [tool, setTool] = useState<MarkerType | null>(null);
  const [markers, setMarkers] = useState<Marker[]>(model.markers);

  const shown = model.floors.filter((f) => visible === "all" || f.level === visible);

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
    `min-h-12 min-w-12 rounded-lg px-4 text-sm font-bold uppercase tracking-wide transition ${
      active ? "bg-yellow-400 text-black" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
    }`;

  return (
    <div className="relative h-full w-full bg-neutral-950">
      <Canvas camera={{ position: [16, 16, 16], fov: 45 }}>
        <color attach="background" args={[xray ? "#050505" : "#111827"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 20, 10]} intensity={1.2} />
        {shown.map((floor) => (
          <group key={floor.level} position={[0, floor.elevation + (exploded ? floor.level * 3 : 0), 0]}>
            {floor.rooms.map((room) => (
              <RoomSlab
                key={room.id}
                room={room}
                xray={xray}
                showLabel={visible !== "all" || exploded}
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
        <gridHelper args={[60, 60, "#333", "#1a1a1a"]} position={[0, -2.5, 0]} />
        <OrbitControls makeDefault />
      </Canvas>

      <div className="absolute left-3 top-3 rounded-lg bg-black/80 px-3 py-2 text-white">
        <div className="text-xs font-bold uppercase tracking-widest text-yellow-400">Estimated layout</div>
        <div className="text-sm">{model.address || `${model.lat.toFixed(5)}, ${model.lng.toFixed(5)}`}</div>
        <div className="text-xs text-neutral-400">
          Source: {model.source} · Confidence {Math.round(model.confidence * 100)}%
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-2 bg-black/80 p-3">
        <button className={btn(visible === "all")} onClick={() => setVisible("all")}>All</button>
        {levels.map((lv) => (
          <button key={lv} className={btn(visible === lv)} onClick={() => setVisible(lv)}>
            {model.floors.find((f) => f.level === lv)?.name}
          </button>
        ))}
        <button className={btn(exploded)} onClick={() => setExploded((v) => !v)}>Explode</button>
        <button className={btn(xray)} onClick={() => setXray((v) => !v)}>X-ray</button>
        <span className="mx-1 w-px bg-neutral-700" />
        {(["fire", "victim", "gas", "shutoff"] as MarkerType[]).map((t) => (
          <button
            key={t}
            className={btn(tool === t)}
            style={tool === t ? { background: MARKER_STYLE[t].color } : undefined}
            onClick={() => setTool((cur) => (cur === t ? null : t))}
          >
            + {MARKER_STYLE[t].label}
          </button>
        ))}
      </div>
    </div>
  );
}
