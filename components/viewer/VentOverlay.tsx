"use client";

import { useMemo } from "react";
import * as THREE from "three";
import type { VentGraph } from "@/lib/vent-paths";

const noopRaycast = () => null;

const BASE_COLOR = "#38bdf8";
const HOT_COLOR = "#fb923c";
const BASE_OPACITY = 0.18;
const HOT_OPACITY = 0.42;
const RADIUS = 0.85;
const RENDER_ORDER = 28;

/**
 * Translucent vertical columns for stair / atrium / shaft stacks.
 * Model frame x=east, y=north → three.js (x, yWorld, -y).
 * Non-interactive; integrator mounts beside the floor groups.
 */
export default function VentOverlay({
  graph,
  highlightStacks,
  floorY,
  ceilingY,
  visible = true,
}: {
  graph: VentGraph;
  highlightStacks?: string[];
  floorY: (level: number) => number;
  ceilingY?: (level: number) => number;
  visible?: boolean;
}) {
  const hot = useMemo(() => new Set(highlightStacks ?? []), [highlightStacks]);

  const columns = useMemo(() => {
    return graph.stacks.map((stack) => {
      const lo = stack.levels[0];
      const hi = stack.levels[stack.levels.length - 1];
      const y0 = floorY(lo);
      const y1 = ceilingY ? ceilingY(hi) : floorY(hi) + 2.7;
      const height = Math.max(0.2, y1 - y0);
      const midY = y0 + height / 2;
      // Average plan center across the stack for a stable column axis.
      const cx = stack.centers.reduce((s, c) => s + c[0], 0) / stack.centers.length;
      const cy = stack.centers.reduce((s, c) => s + c[1], 0) / stack.centers.length;
      const highlighted = hot.has(stack.id);
      return {
        id: stack.id,
        position: [cx, midY, -cy] as [number, number, number],
        height,
        highlighted,
      };
    });
  }, [graph.stacks, floorY, ceilingY, hot]);

  if (!visible || columns.length === 0) return null;

  return (
    <group>
      {columns.map((col) => (
        <mesh
          key={col.id}
          position={col.position}
          renderOrder={RENDER_ORDER}
          raycast={noopRaycast}
          frustumCulled={false}
        >
          <cylinderGeometry args={[RADIUS, RADIUS, col.height, 20, 1, true]} />
          <meshBasicMaterial
            color={col.highlighted ? HOT_COLOR : BASE_COLOR}
            transparent
            opacity={col.highlighted ? HOT_OPACITY : BASE_OPACITY}
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
