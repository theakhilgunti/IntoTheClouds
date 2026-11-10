/**
 * Structural uncertainty / void-risk scoring for Incident Command overlays.
 *
 * HONEST FRAMING: this is a confidence / unknown-structure heatmap for IC
 * situational awareness — NOT engineering analysis, NOT a prediction that a
 * room "will collapse". Label UI as "unknown structure / confidence".
 *
 * Heuristics (additive, capped at 1.0):
 * - Base from interior.status: verified ≈ 0.15, estimated ≈ 0.45, unknown ≈ 0.7
 * - Open spans (living / lobby / atrium / warehouse / gym) raise uncertainty
 * - Top-floor rooms under mansard or hip roofs get a slight bump
 * - Basement (level < 0) under an occupied building gets a bump
 * - Large room area vs footprint fraction raises uncertainty
 * - Close neighbor compound features add a mild exposure bump
 */
import type { BuildingModel, Point, Room, RoofShape } from "../packages/schema/building-model";
import { polygonArea } from "./geo";

export type RoomRisk = {
  roomId: string;
  level: number;
  score: number; // 0..1
  reasons: string[];
};

const STATUS_BASE: Record<"verified" | "estimated" | "unknown", number> = {
  verified: 0.15,
  estimated: 0.45,
  unknown: 0.7,
};

const OPEN_SPAN_TYPES = new Set(["living", "lobby", "atrium", "warehouse", "gym"]);

const OPEN_SPAN_NAME_RE = /\b(lobby|atrium|warehouse|gym|gymnasium|lecture|auditorium)\b/i;

const ROOF_TOP_BUMP = new Set<RoofShape>(["mansard", "hip"]);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function statusBase(model: BuildingModel): { base: number; reason: string } {
  const status = model.interior?.status ?? "unknown";
  const base = STATUS_BASE[status] ?? STATUS_BASE.unknown;
  if (status === "verified") {
    return { base, reason: "Interior verified — lower structural uncertainty" };
  }
  if (status === "estimated") {
    return { base, reason: "Interior estimated — typical layout, not measured" };
  }
  return { base, reason: "Interior unknown — high structural uncertainty" };
}

function isOpenSpan(room: Room): boolean {
  if (OPEN_SPAN_TYPES.has(room.type)) return true;
  // Schema maps lobbies/atriums to hallway/other; catch by name.
  if (room.type === "hallway" || room.type === "other" || room.type === "office") {
    return OPEN_SPAN_NAME_RE.test(room.name) || OPEN_SPAN_NAME_RE.test(room.id);
  }
  return OPEN_SPAN_NAME_RE.test(room.name);
}

function openSpanBump(room: Room): { bump: number; reason: string } | null {
  if (room.type === "stair") return null;
  if (!isOpenSpan(room)) return null;
  return {
    bump: 0.12,
    reason: `Open-span room (${room.type}${OPEN_SPAN_NAME_RE.test(room.name) ? ` / ${room.name}` : ""}) — fewer known partitions`,
  };
}

function topFloorUnderRoof(
  model: BuildingModel,
  level: number,
): { bump: number; reason: string } | null {
  const shape = model.roof?.shape;
  if (!shape || !ROOF_TOP_BUMP.has(shape)) return null;
  const topLevel = Math.max(...model.floors.map((f) => f.level));
  if (level !== topLevel || topLevel < 0) return null;
  return {
    bump: 0.06,
    reason: `Top floor under ${shape} roof — eaves / void geometry uncertain`,
  };
}

function basementBump(
  model: BuildingModel,
  level: number,
): { bump: number; reason: string } | null {
  if (level >= 0) return null;
  const occupiedAbove = model.floors.some(
    (f) => f.level >= 0 && f.rooms.some((r) => r.type !== "stair" && r.type !== "closet"),
  );
  if (!occupiedAbove && model.floors.every((f) => f.level < 0)) return null;
  return {
    bump: 0.1,
    reason: "Basement under occupied floors — void / support uncertainty",
  };
}

function largeAreaBump(
  room: Room,
  footprintArea: number,
): { bump: number; reason: string } | null {
  if (footprintArea <= 1e-6) return null;
  const area = polygonArea(room.polygon as Point[]);
  const frac = area / footprintArea;
  if (frac < 0.22) return null;
  const bump = frac >= 0.4 ? 0.14 : frac >= 0.3 ? 0.1 : 0.06;
  return {
    bump,
    reason: `Large room (~${Math.round(frac * 100)}% of footprint) — open plan uncertainty`,
  };
}

function neighborExposureBump(model: BuildingModel): { bump: number; reason: string } | null {
  const neighbors = model.compound?.features.filter((f) => f.kind === "neighbor") ?? [];
  if (neighbors.length === 0) return null;
  return {
    bump: neighbors.length >= 3 ? 0.05 : 0.03,
    reason: `Neighbor exposure (${neighbors.length} adjacent structure${neighbors.length === 1 ? "" : "s"})`,
  };
}

function stairNote(room: Room): { bump: number; reason: string } | null {
  if (room.type !== "stair") return null;
  return {
    bump: 0.04,
    reason: "Stair shaft — vertical void; treat as circulation, not collapse physics",
  };
}

/**
 * Score each room for structural uncertainty (0 = more confident layout knowledge,
 * 1 = high unknown / void-risk attention). Returns [] when there are no rooms.
 */
export function scoreRooms(model: BuildingModel): RoomRisk[] {
  const roomsPresent = model.floors.some((f) => f.rooms.length > 0);
  if (!roomsPresent) return [];

  const { base, reason: baseReason } = statusBase(model);
  const footprintArea = polygonArea(model.footprint as Point[]);
  const neighbor = neighborExposureBump(model);
  const out: RoomRisk[] = [];

  for (const floor of model.floors) {
    for (const room of floor.rooms) {
      let score = base;
      const reasons: string[] = [baseReason];

      const open = openSpanBump(room);
      if (open) {
        score += open.bump;
        reasons.push(open.reason);
      }

      const roof = topFloorUnderRoof(model, floor.level);
      if (roof) {
        score += roof.bump;
        reasons.push(roof.reason);
      }

      const bas = basementBump(model, floor.level);
      if (bas) {
        score += bas.bump;
        reasons.push(bas.reason);
      }

      const large = largeAreaBump(room, footprintArea);
      if (large) {
        score += large.bump;
        reasons.push(large.reason);
      }

      if (neighbor) {
        score += neighbor.bump;
        reasons.push(neighbor.reason);
      }

      const stair = stairNote(room);
      if (stair) {
        score += stair.bump;
        reasons.push(stair.reason);
      }

      out.push({
        roomId: room.id,
        level: floor.level,
        score: clamp01(score),
        reasons,
      });
    }
  }

  return out;
}

/**
 * Alias emphasizing the honest IC meaning: confidence / unknown-structure overlay,
 * not a structural-engineering collapse forecast.
 */
export const confidenceRisk = scoreRooms;

/**
 * Amber → red CSS hex for blueprint-friendly hatch overlays.
 * Low score (more confident) stays amber; high score (unknown/void attention) goes red.
 */
export function riskColor(score: number): string {
  const t = clamp01(score);
  // Amber #F59E0B → Red #DC2626
  const a = { r: 0xf5, g: 0x9e, b: 0x0b };
  const b = { r: 0xdc, g: 0x26, b: 0x26 };
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}
