/**
 * Template layouts: used for the demo house and as the fallback when the
 * Claude layout generator fails validation. Builds a rectangular two-story
 * colonial (plus optional basement) inside a W x D footprint centered at 0,0.
 */
import type { BuildingModel, Door, Floor, Room, Wall, Point } from "@/packages/schema/building-model";

type Rect = { x0: number; y0: number; x1: number; y1: number };
const rect = (r: Rect): Point[] => [
  [r.x0, r.y0],
  [r.x1, r.y0],
  [r.x1, r.y1],
  [r.x0, r.y1],
];

function exteriorWalls(prefix: string, w: number, d: number): Wall[] {
  const hx = w / 2, hy = d / 2;
  const c: Point[] = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  return c.map((a, i) => ({
    id: `${prefix}-ext-${i}`,
    a,
    b: c[(i + 1) % 4],
    thickness: 0.25,
    exterior: true,
  }));
}

const wall = (id: string, a: Point, b: Point): Wall => ({ id, a, b, thickness: 0.12, exterior: false });
const door = (id: string, wallId: string, t: number, exit = false): Door => ({ id, wallId, t, width: exit ? 1.0 : 0.85, exit });
const room = (id: string, name: string, type: Room["type"], r: Rect): Room => ({ id, name, type, polygon: rect(r) });

export function colonialTemplate(opts: {
  id: string;
  lat: number;
  lng: number;
  address?: string;
  width?: number;
  depth?: number;
  basement?: boolean;
  source?: BuildingModel["source"];
  confidence?: number;
}): BuildingModel {
  const w = opts.width ?? 12;
  const d = opts.depth ?? 9;
  const hx = w / 2, hy = d / 2;
  // Central hall/stair band, 2.4 m wide, running front (south, -y) to back.
  const sx0 = -1.2, sx1 = 1.2;
  const stairRect: Rect = { x0: sx0, y0: 0.5, x1: sx1, y1: hy - 0.5 };

  const ground: Floor = {
    level: 0,
    name: "1st Floor",
    elevation: 0,
    height: 2.7,
    rooms: [
      room("g-living", "Living Room", "living", { x0: -hx, y0: -hy, x1: sx0, y1: 0.5 }),
      room("g-dining", "Dining Room", "dining", { x0: sx1, y0: -hy, x1: hx, y1: 0.5 }),
      room("g-hall", "Front Hall", "hallway", { x0: sx0, y0: -hy, x1: sx1, y1: 0.5 }),
      room("g-stair", "Main Stairs", "stair", stairRect),
      room("g-family", "Family Room", "living", { x0: -hx, y0: 0.5, x1: sx0, y1: hy }),
      room("g-kitchen", "Kitchen", "kitchen", { x0: sx1, y0: 0.5, x1: hx, y1: hy }),
    ],
    walls: [
      ...exteriorWalls("g", w, d),
      wall("g-w1", [sx0, -hy], [sx0, hy]),
      wall("g-w2", [sx1, -hy], [sx1, hy]),
      wall("g-w3", [-hx, 0.5], [sx0, 0.5]),
      wall("g-w4", [sx1, 0.5], [hx, 0.5]),
    ],
    doors: [
      door("g-d-front", "g-ext-0", 0.5, true),
      door("g-d-back", "g-ext-2", 0.25, true),
      door("g-d1", "g-w1", 0.25),
      door("g-d2", "g-w2", 0.25),
      door("g-d3", "g-w1", 0.75),
      door("g-d4", "g-w2", 0.75),
      door("g-d5", "g-w3", 0.5),
      door("g-d6", "g-w4", 0.5),
    ],
    stairs: [{ id: "g-s1", polygon: rect(stairRect), toLevel: 1 }],
  };

  const upper: Floor = {
    level: 1,
    name: "2nd Floor",
    elevation: 2.7,
    height: 2.5,
    rooms: [
      room("u-master", "Master Bedroom", "bedroom", { x0: -hx, y0: -hy, x1: sx0, y1: 0.5 }),
      room("u-bed2", "Bedroom 2", "bedroom", { x0: sx1, y0: -hy, x1: hx, y1: 0.5 }),
      room("u-hall", "Upstairs Hall", "hallway", { x0: sx0, y0: -hy, x1: sx1, y1: 0.5 }),
      room("u-stair", "Main Stairs", "stair", stairRect),
      room("u-bath", "Bathroom", "bathroom", { x0: -hx, y0: 0.5, x1: sx0, y1: hy }),
      room("u-bed3", "Bedroom 3", "bedroom", { x0: sx1, y0: 0.5, x1: hx, y1: hy }),
    ],
    walls: [
      ...exteriorWalls("u", w, d),
      wall("u-w1", [sx0, -hy], [sx0, hy]),
      wall("u-w2", [sx1, -hy], [sx1, hy]),
      wall("u-w3", [-hx, 0.5], [sx0, 0.5]),
      wall("u-w4", [sx1, 0.5], [hx, 0.5]),
    ],
    doors: [
      door("u-d1", "u-w1", 0.25),
      door("u-d2", "u-w2", 0.25),
      door("u-d3", "u-w1", 0.75),
      door("u-d4", "u-w2", 0.75),
    ],
    stairs: [],
  };

  const floors: Floor[] = [ground, upper];

  if (opts.basement ?? true) {
    floors.unshift({
      level: -1,
      name: "Basement",
      elevation: -2.4,
      height: 2.3,
      rooms: [
        room("b-main", "Basement", "basement", { x0: -hx, y0: -hy, x1: sx0, y1: hy }),
        room("b-stair", "Basement Stairs", "stair", stairRect),
        room("b-util", "Utility / Breaker Panel", "utility", { x0: sx1, y0: -hy, x1: hx, y1: hy }),
      ],
      walls: [
        ...exteriorWalls("b", w, d),
        wall("b-w1", [sx0, -hy], [sx0, hy]),
        wall("b-w2", [sx1, -hy], [sx1, hy]),
      ],
      doors: [door("b-d1", "b-w1", 0.5), door("b-d2", "b-w2", 0.5)],
      stairs: [{ id: "b-s1", polygon: rect(stairRect), toLevel: 0 }],
    });
  }

  return {
    id: opts.id,
    source: opts.source ?? "demo",
    confidence: opts.confidence ?? 0.5,
    address: opts.address ?? "",
    lat: opts.lat,
    lng: opts.lng,
    footprint: rect({ x0: -hx, y0: -hy, x1: hx, y1: hy }),
    floors,
    markers: [],
    roof: { shape: "gable", center: [0, 0], width: w, depth: d, rotation: 0, height: 2.6 },
  };
}
