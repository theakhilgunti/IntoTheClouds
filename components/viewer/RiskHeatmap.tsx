"use client";

/**
 * Translucent amber→red floor hatch for structural uncertainty / confidence.
 * Label as "unknown structure / confidence" — not a collapse prediction.
 */
import { useMemo } from "react";
import * as THREE from "three";
import type { BuildingModel, Room } from "@/packages/schema/building-model";
import { riskColor, type RoomRisk } from "@/lib/structural-risk";

const OVERLAY_Y = 0.11; // slightly above RoomSlab default y=0.08

function defaultFloorY(model: BuildingModel, level: number): number {
  const floor = model.floors.find((f) => f.level === level);
  return floor?.elevation ?? level * 2.7;
}

function findRoom(model: BuildingModel, roomId: string, level: number): Room | undefined {
  const floor = model.floors.find((f) => f.level === level);
  return floor?.rooms.find((r) => r.id === roomId);
}

function RoomRiskPatch({
  room,
  score,
  y,
}: {
  room: Room;
  score: number;
  y: number;
}) {
  const geom = useMemo(() => {
    const shape = new THREE.Shape(room.polygon.map(([x, py]) => new THREE.Vector2(x, py)));
    return new THREE.ShapeGeometry(shape);
  }, [room.polygon]);

  const color = riskColor(score);
  // Opacity scales with uncertainty; keep a visible floor even at low score.
  const opacity = 0.12 + score * 0.45;

  return (
    <mesh
      geometry={geom}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, y, 0]}
      renderOrder={4}
      userData={{ riskRoomId: room.id, riskScore: score }}
    >
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-3}
        polygonOffsetUnits={-3}
      />
    </mesh>
  );
}

/**
 * R3F overlay: flat translucent polygons on room floors.
 * Pass `floorY` when the parent Viewer uses explode offsets so levels stay aligned.
 */
export default function RiskHeatmap({
  model,
  risks,
  activeLevel = null,
  visible = true,
  floorY,
  skipStairs = true,
}: {
  model: BuildingModel;
  risks: RoomRisk[];
  activeLevel?: number | null;
  visible?: boolean;
  /** Absolute world Y for a floor level. Defaults to Floor.elevation. */
  floorY?: (level: number) => number;
  /** Hide stair rooms (scored separately; shafts are circulation voids). Default true. */
  skipStairs?: boolean;
}) {
  const patches = useMemo(() => {
    if (!visible) return [];
    const resolveY = floorY ?? ((level: number) => defaultFloorY(model, level));
    const out: { key: string; room: Room; score: number; y: number }[] = [];

    for (const risk of risks) {
      if (activeLevel != null && risk.level !== activeLevel) continue;
      const room = findRoom(model, risk.roomId, risk.level);
      if (!room) continue;
      if (skipStairs && room.type === "stair") continue;
      out.push({
        key: `${risk.level}:${risk.roomId}`,
        room,
        score: risk.score,
        y: resolveY(risk.level) + OVERLAY_Y,
      });
    }
    return out;
  }, [model, risks, activeLevel, visible, floorY, skipStairs]);

  if (!visible || patches.length === 0) return null;

  return (
    <group name="risk-heatmap" userData={{ label: "unknown structure / confidence" }}>
      {patches.map((p) => (
        <RoomRiskPatch key={p.key} room={p.room} score={p.score} y={p.y} />
      ))}
    </group>
  );
}

/** Re-export helpers so integrators can wire scoring without hunting the lib. */
export type { RoomRisk };
export { riskColor };
