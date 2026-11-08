/**
 * Pure OSM indoor → BuildingModel overlay (no network). node:test friendly.
 */
export type Point2 = [number, number];

export type IndoorRoomLite = {
  id: number;
  name: string;
  type: string;
  level: number;
  ring: Point2[];
};

export type FloorLite = {
  level: number;
  rooms: { id: string; name: string; type: string; polygon: Point2[] }[];
  [key: string]: unknown;
};

export type ModelLite = {
  footprint: Point2[];
  floors: FloorLite[];
  interior?: {
    status: "verified" | "estimated" | "unknown";
    source?: string;
    reasons: string[];
    knownLevels: number[];
    notes: string[];
  };
  [key: string]: unknown;
};

function signedArea(ring: Point2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function centroid(ring: Point2[]): Point2 {
  let x = 0, y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  const n = Math.max(1, ring.length);
  return [x / n, y / n];
}

function pointInPolygon(p: Point2, ring: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 0) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function roomHitsFootprint(ring: Point2[], footprint: Point2[]): boolean {
  const c = centroid(ring);
  if (pointInPolygon(c, footprint)) return true;
  return ring.some((p) => pointInPolygon(p, footprint));
}

export type IndoorOverlayResultLite = {
  model: ModelLite;
  used: number;
  note: string;
};

/**
 * When enough indoor rooms overlap the footprint, replace estimated room polygons
 * on matching floors. Keep template stairs when indoor has no stair geometry.
 */
export function overlayIndoorOnModel(
  model: ModelLite,
  rooms: IndoorRoomLite[],
  opts?: { minRooms?: number },
): IndoorOverlayResultLite | null {
  const minRooms = opts?.minRooms ?? 3;
  const footprint = model.footprint;
  if (!footprint || footprint.length < 3) return null;
  const hits = rooms.filter((r) => roomHitsFootprint(r.ring, footprint) && Math.abs(signedArea(r.ring)) >= 0.5);
  if (hits.length < minRooms) return null;

  const byLevel = new Map<number, IndoorRoomLite[]>();
  for (const r of hits) {
    const list = byLevel.get(r.level) ?? [];
    list.push(r);
    byLevel.set(r.level, list);
  }

  const floors = model.floors.map((fl) => {
    const indoor = byLevel.get(fl.level);
    if (!indoor || indoor.length === 0) return fl;
    const templateStairs = fl.rooms.filter((r) => r.type === "stair");
    const mapped = indoor.map((r, i) => ({
      id: `in-${r.id}-${i}`,
      name: r.name,
      type: r.type,
      polygon: r.ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as Point2),
    }));
    const hasStair = mapped.some((r) => r.type === "stair");
    return { ...fl, rooms: hasStair ? mapped : [...mapped, ...templateStairs] };
  });

  return {
    model: {
      ...model,
      floors,
      interior: {
        status: "estimated",
        source: "OpenStreetMap Simple Indoor",
        reasons: [],
        knownLevels: [...byLevel.keys()].sort((a, b) => a - b),
        notes: [
          `Used ${hits.length} OSM indoor room(s) that overlap this footprint. Walls/exits may still follow the estimated shell.`,
        ],
      },
    },
    used: hits.length,
    note: `OSM indoor: ${hits.length} room(s) overlaid`,
  };
}
