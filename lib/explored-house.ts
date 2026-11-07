/**
 * Turns a finished walk into a BuildingModel whose origin is the footprint center.
 * Tracker coordinates stay in rawTrail; the model itself is in the building frame
 * (x = east, y = north, origin at the center of the explored extent).
 */

export type XY = [number, number];

export type TrailPoint = { x: number; y: number; z?: number };

export type IncomingHazard = {
  id: string;
  hazard_type: string;
  x: number;
  y: number;
  z?: number;
  note?: string | null;
  label?: string;
  timestamp: number;
};

export type MarkerLike = {
  id: string;
  type: "fire" | "victim" | "gas" | "shutoff" | "hazard" | "entry";
  floor: number;
  pos: XY;
  note: string;
  createdAt: string;
};

export type FloorRecord = {
  level: number;
  name: string;
  elevation: number;
  height: number;
  rooms: Array<{ id: string; name: string; type: string; polygon: XY[] }>;
  walls: Array<{ id: string; a: XY; b: XY; thickness: number; exterior: boolean }>;
  doors: Array<{ id: string; wallId: string; t: number; width: number; exit: boolean }>;
  stairs: unknown[];
};

export type HouseRecord = {
  id: string;
  source: string;
  confidence: number;
  address: string;
  lat: number;
  lng: number;
  footprint: XY[];
  floors: FloorRecord[];
  markers: MarkerLike[];
  rawTrail?: TrailPoint[];
  rawHazards?: IncomingHazard[];
  revision?: number;
};

export type HouseDimensions = {
  widthM: number;
  depthM: number;
  floorCount: number;
  footprintAreaM2: number;
  exploredWidthM: number | null;
  exploredDepthM: number | null;
  floors: Array<{
    level: number;
    name: string;
    elevation: number;
    height: number;
    rooms: Array<{ id: string; name: string; type: string; areaM2: number }>;
  }>;
};

export type ExplorationInput = {
  buildingId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string;
  lat: number;
  lng: number;
  address: string;
  breadcrumbs: TrailPoint[];
  hazards: IncomingHazard[];
};

export type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  measuredWidth: number;
  measuredDepth: number;
  width: number;
  depth: number;
};

const MARKER_TYPES = new Set(["fire", "victim", "gas", "shutoff", "hazard", "entry"]);
const MAX_TRAIL = 5000;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function markerType(hazardType: string): MarkerLike["type"] {
  const t = hazardType.toLowerCase();
  if (t === "collapse" || t === "blocked") return "hazard";
  if (MARKER_TYPES.has(t)) return t as MarkerLike["type"];
  return "hazard";
}

export function isoFromUnix(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

export function polygonArea(poly: XY[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function boundsOf(points: Array<{ x: number; y: number }>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const measuredWidth = maxX - minX;
  const measuredDepth = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    measuredWidth,
    measuredDepth,
    width: Math.max(measuredWidth, 1),
    depth: Math.max(measuredDepth, 1),
  };
}

export function measureModel(
  model: Pick<HouseRecord, "footprint" | "floors">,
  explored?: { exploredWidthM: number; exploredDepthM: number } | null,
): HouseDimensions {
  const footprint = boundsOf(model.footprint.map(([x, y]) => ({ x, y })));
  return {
    widthM: round2(footprint.measuredWidth),
    depthM: round2(footprint.measuredDepth),
    floorCount: model.floors.length,
    footprintAreaM2: round2(polygonArea(model.footprint)),
    exploredWidthM: explored ? round2(explored.exploredWidthM) : null,
    exploredDepthM: explored ? round2(explored.exploredDepthM) : null,
    floors: model.floors.map((floor) => ({
      level: floor.level,
      name: floor.name,
      elevation: floor.elevation,
      height: floor.height,
      rooms: floor.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        type: room.type,
        areaM2: round2(polygonArea(room.polygon)),
      })),
    })),
  };
}

function exteriorWalls(width: number, depth: number): FloorRecord["walls"] {
  const hx = width / 2;
  const hy = depth / 2;
  const corners: XY[] = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  return corners.map((a, i) => ({
    id: `explored-ext-${i}`,
    a,
    b: corners[(i + 1) % 4],
    thickness: 0.25,
    exterior: true,
  }));
}

export function buildWifiHouse(opts: {
  id: string;
  lat: number;
  lng: number;
  address: string;
  confidence: number;
  width: number;
  depth: number;
  markers: MarkerLike[];
}): HouseRecord {
  const hx = opts.width / 2;
  const hy = opts.depth / 2;
  const footprint: XY[] = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  return {
    id: opts.id,
    source: "wifi",
    confidence: opts.confidence,
    address: opts.address,
    lat: opts.lat,
    lng: opts.lng,
    footprint,
    floors: [
      {
        level: 0,
        name: "Explored",
        elevation: 0,
        height: 2.7,
        rooms: [
          {
            id: "explored-room",
            name: "Explored area",
            type: "other",
            polygon: footprint,
          },
        ],
        walls: exteriorWalls(opts.width, opts.depth),
        doors: [{ id: "explored-exit", wallId: "explored-ext-0", t: 0.5, width: 0.9, exit: true }],
        stairs: [],
      },
    ],
    markers: opts.markers,
  };
}

export function hazardsToMarkers(hazards: IncomingHazard[], bounds: Bounds): MarkerLike[] {
  return hazards.map((hazard) => ({
    id: hazard.id,
    type: markerType(hazard.hazard_type),
    floor: 0,
    pos: [round2(hazard.x - bounds.cx), round2(hazard.y - bounds.cy)],
    note: hazard.note || hazard.label || "",
    createdAt: isoFromUnix(hazard.timestamp),
  }));
}

export function applyExploration(existing: HouseRecord | null, input: ExplorationInput) {
  const incoming = input.breadcrumbs.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z ?? 1,
  }));

  const prior = existing?.source === "wifi" ? existing : null;
  if (prior || !existing) {
    const rawTrail = [...(prior?.rawTrail ?? []), ...incoming].slice(-MAX_TRAIL);
    const hazards = new Map<string, IncomingHazard>();
    for (const hazard of prior?.rawHazards ?? []) hazards.set(hazard.id, hazard);
    for (const hazard of input.hazards) hazards.set(hazard.id, hazard);
    const rawHazards = [...hazards.values()];
    const bounds = boundsOf(rawTrail);
    const model = buildWifiHouse({
      id: input.buildingId,
      lat: prior?.lat ?? input.lat,
      lng: prior?.lng ?? input.lng,
      address: prior?.address || input.address,
      confidence: Math.min(0.85, Math.max(0.2, 0.2 + rawTrail.length / 400)),
      width: bounds.width,
      depth: bounds.depth,
      markers: hazardsToMarkers(rawHazards, bounds),
    });
    return {
      model,
      rawTrail,
      rawHazards,
      placedOnPlan: true,
      revision: (prior?.revision ?? 0) + 1,
      exploredWidthM: bounds.measuredWidth,
      exploredDepthM: bounds.measuredDepth,
    };
  }

  // A non-wifi document is not a scanner house. The walk is still saved as its own wifi house.
  return applyExploration(null, input);
}
