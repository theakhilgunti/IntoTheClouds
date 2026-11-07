/**
 * Layout engine: turns "what we know about the house" (footprint, floors, garage, roof)
 * into a BuildingModel with rooms, walls, doors and stairs.
 *
 * Interior rooms are an estimate: no public data source has real floor plans, so we lay out
 * a typical American house plan inside the real footprint. Walls are derived from the room
 * rectangles, so the plan is always consistent (every room is reachable, no overlaps).
 *
 * Plan frame: meters, house centered at 0,0, front of the house at -y, +x on your right
 * when you stand on the street looking at the front door.
 */
import type {
  BuildingModel, Door, Floor, Point, Roof, RoofShape, RoomType, Stairs, Wall,
} from "@/packages/schema/building-model";
import { minAreaRect } from "./geo";

type Rect = { x0: number; y0: number; x1: number; y1: number };
type PlanRoom = { id: string; name: string; type: RoomType; r: Rect; zone: string };
type PlanFloor = { level: number; rooms: PlanRoom[]; stair: Rect | null };

export type GarageSide = "none" | "left" | "right";

export type HouseSpec = {
  width: number; // across the front
  depth: number; // front to back
  stories: number; // above ground, 1..3
  basement: boolean;
  garage: GarageSide;
};

const FLOOR_NAMES: Record<number, string> = { [-1]: "Basement", 0: "1st Floor", 1: "2nd Floor", 2: "3rd Floor" };
const STAIR_LEN = 3.6;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Lay out rooms for every floor in the plan frame. */
function planHouse(spec: HouseSpec, notes: string[]): PlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;

  // Attached garage takes a strip on one side of the ground floor.
  let mx0 = x0, mx1 = x1;
  let garageRooms: PlanRoom[] = [];
  if (spec.garage !== "none") {
    if (W >= 11) {
      const gW = Math.min(6.5, Math.max(3.5, W * 0.33));
      const gD = Math.min(D, 7);
      const gx0 = spec.garage === "right" ? x1 - gW : x0;
      const gx1 = spec.garage === "right" ? x1 : x0 + gW;
      garageRooms.push({ id: "garage", name: "Garage", type: "garage", r: { x0: gx0, y0, x1: gx1, y1: y0 + gD }, zone: "garage" });
      if (D - gD > 1.5) {
        garageRooms.push({ id: "mud", name: "Mudroom / Laundry", type: "utility", r: { x0: gx0, y0: y0 + gD, x1: gx1, y1 }, zone: "mud" });
      }
      if (spec.garage === "right") mx1 = gx0;
      else mx0 = gx1;
    } else {
      notes.push("The photos suggest an attached garage, but the footprint is too narrow to fit one, so it was left out.");
      garageRooms = [];
    }
  }

  const Wm = mx1 - mx0;
  const hasStairs = spec.stories > 1 || spec.basement;
  const floors: PlanFloor[] = [];
  let bedroomNo = 1;
  const bed = (id: string, r: Rect): PlanRoom => {
    const n = bedroomNo++;
    return { id, name: n === 1 ? "Primary Bedroom" : `Bedroom ${n}`, type: "bedroom", r, zone: id };
  };

  // Hall band: a center hall for wide houses, a side hall for narrow (row-house style) ones.
  const center = Wm >= 8.5;
  let hx0: number, hx1: number, front: number;
  if (center) {
    const mid = (mx0 + mx1) / 2;
    hx0 = mid - 1.2; hx1 = mid + 1.2;
    front = y0 + D * 0.5;
  } else {
    hx1 = mx1; hx0 = mx1 - Math.min(1.3, Wm * 0.25);
    front = y0 + D * 0.36;
  }
  const stairEnd = Math.min(y1, front + STAIR_LEN);
  const stair: Rect | null = hasStairs ? { x0: hx0, y0: front, x1: hx1, y1: stairEnd } : null;

  function hallPieces(prefix: string, frontName: string): PlanRoom[] {
    const out: PlanRoom[] = [{ id: `${prefix}hall`, name: frontName, type: "hallway", r: { x0: hx0, y0, x1: hx1, y1: front }, zone: "hall" }];
    if (stair) out.push({ id: `${prefix}stair`, name: "Stairs", type: "stair", r: stair, zone: "hall" });
    else out.push({ id: `${prefix}hall2`, name: frontName, type: "hallway", r: { x0: hx0, y0: front, x1: hx1, y1: stairEnd }, zone: "hall" });
    if (stairEnd < y1 - 0.3) {
      out.push({ id: `${prefix}backhall`, name: "Back Hall", type: "hallway", r: { x0: hx0, y0: stairEnd, x1: hx1, y1 }, zone: "hall" });
    }
    return out;
  }

  // Ground floor
  const g: PlanRoom[] = [...garageRooms, ...hallPieces("g-", "Front Hall")];
  if (center) {
    g.push(
      { id: "living", name: "Living Room", type: "living", r: { x0: mx0, y0, x1: hx0, y1: front }, zone: "living" },
      { id: "dining", name: "Dining Room", type: "dining", r: { x0: hx1, y0, x1: mx1, y1: front }, zone: "dining" },
      { id: "family", name: "Family Room", type: "living", r: { x0: mx0, y0: front, x1: hx0, y1 }, zone: "family" },
      { id: "kitchen", name: "Kitchen", type: "kitchen", r: { x0: hx1, y0: front, x1: mx1, y1 }, zone: "kitchen" },
    );
  } else {
    const b = y0 + D * 0.66;
    g.push(
      { id: "living", name: "Living Room", type: "living", r: { x0: mx0, y0, x1: hx0, y1: front }, zone: "living" },
      { id: "dining", name: "Dining Room", type: "dining", r: { x0: mx0, y0: front, x1: hx0, y1: b }, zone: "dining" },
      { id: "kitchen", name: "Kitchen", type: "kitchen", r: { x0: mx0, y0: b, x1: hx0, y1 }, zone: "kitchen" },
    );
  }
  floors.push({ level: 0, rooms: g, stair });

  // Upper floors
  for (let lv = 1; lv < spec.stories; lv++) {
    const p = `u${lv}-`;
    const u: PlanRoom[] = hallPieces(p, "Upstairs Hall");
    if (center) {
      u.push(
        bed(`${p}bedA`, { x0: mx0, y0, x1: hx0, y1: front }),
        bed(`${p}bedB`, { x0: hx1, y0, x1: mx1, y1: front }),
        { id: `${p}bath`, name: "Bathroom", type: "bathroom", r: { x0: mx0, y0: front, x1: hx0, y1 }, zone: `${p}bath` },
        bed(`${p}bedC`, { x0: hx1, y0: front, x1: mx1, y1 }),
      );
    } else {
      const b = y0 + D * 0.62;
      u.push(
        bed(`${p}bedA`, { x0: mx0, y0, x1: hx0, y1: front }),
        { id: `${p}bath`, name: "Bathroom", type: "bathroom", r: { x0: mx0, y0: front, x1: hx0, y1: b }, zone: `${p}bath` },
        bed(`${p}bedB`, { x0: mx0, y0: b, x1: hx0, y1 }),
      );
    }
    floors.push({ level: lv, rooms: u, stair });
  }

  if (spec.stories === 1) {
    // Single story: bedrooms replace the family room / dining on the ground floor.
    const fam = g.find((r) => r.id === (center ? "family" : "dining"));
    if (fam) Object.assign(fam, { name: "Primary Bedroom", type: "bedroom" as RoomType });
  }

  // Basement: open space with the stairs and a utility room (breaker panel, furnace, water heater).
  if (spec.basement) {
    const b: PlanRoom[] = [
      { id: "b-stair", name: "Basement Stairs", type: "stair", r: stair!, zone: "base" },
      { id: "b-hallF", name: "Basement", type: "basement", r: { x0: hx0, y0, x1: hx1, y1: front }, zone: "base" },
      { id: "b-main", name: "Basement", type: "basement", r: { x0: mx0, y0, x1: hx0, y1 }, zone: "base" },
    ];
    if (stairEnd < y1 - 0.3) b.push({ id: "b-hallB", name: "Basement", type: "basement", r: { x0: hx0, y0: stairEnd, x1: hx1, y1 }, zone: "base" });
    if (center) b.push({ id: "b-util", name: "Utility / Breaker Panel", type: "utility", r: { x0: hx1, y0, x1: mx1, y1 }, zone: "util" });
    else {
      // Narrow house: utility at the back of the main column.
      const main = b.find((r) => r.id === "b-main")!;
      main.r = { ...main.r, y1: y0 + D * 0.7 };
      b.push({ id: "b-util", name: "Utility / Breaker Panel", type: "utility", r: { x0: mx0, y0: y0 + D * 0.7, x1: hx0, y1 }, zone: "util" });
    }
    floors.unshift({ level: -1, rooms: b, stair });
  }
  return floors;
}

/** Derive walls (between different zones) and doors (so every room is reachable) from the room rectangles. */
function wallsAndDoors(prefix: string, rooms: PlanRoom[], isGround: boolean) {
  const xs = [...new Set(rooms.flatMap((r) => [r4(r.r.x0), r4(r.r.x1)]))].sort((a, b) => a - b);
  const ys = [...new Set(rooms.flatMap((r) => [r4(r.r.y0), r4(r.r.y1)]))].sort((a, b) => a - b);
  const zoneAt = (cx: number, cy: number): string | null => {
    const r = rooms.find((q) => cx > q.r.x0 && cx < q.r.x1 && cy > q.r.y0 && cy < q.r.y1);
    return r ? r.zone : null;
  };

  type Seg = { a: Point; b: Point; zA: string | null; zB: string | null };
  const segs: Seg[] = [];
  const eps = 1e-3;
  for (let k = 0; k < xs.length; k++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      const L = zoneAt(xs[k] - eps, cy), R = zoneAt(xs[k] + eps, cy);
      if (L !== R) segs.push({ a: [xs[k], ys[j]], b: [xs[k], ys[j + 1]], zA: L, zB: R });
    }
  }
  for (let j = 0; j < ys.length; j++) {
    for (let k = 0; k < xs.length - 1; k++) {
      const cx = (xs[k] + xs[k + 1]) / 2;
      const B = zoneAt(cx, ys[j] - eps), T = zoneAt(cx, ys[j] + eps);
      if (B !== T) segs.push({ a: [xs[k], ys[j]], b: [xs[k + 1], ys[j]], zA: B, zB: T });
    }
  }

  // Merge collinear touching segments that separate the same two zones.
  type W = Wall & { zones: [string | null, string | null] };
  const walls: W[] = [];
  for (const s of segs) {
    const key = (z: [string | null, string | null]) => [z[0] ?? "", z[1] ?? ""].sort().join("|");
    const prev = walls.find(
      (w) => key(w.zones) === key([s.zA, s.zB]) && w.b[0] === s.a[0] && w.b[1] === s.a[1] &&
        (w.a[0] === s.b[0] || w.a[1] === s.b[1]),
    );
    if (prev) prev.b = s.b;
    else {
      const ext = s.zA === null || s.zB === null;
      walls.push({ id: "", a: s.a, b: s.b, thickness: ext ? 0.25 : 0.12, exterior: ext, zones: [s.zA, s.zB] });
    }
  }
  walls.forEach((w, i) => (w.id = `${prefix}w${i}`));

  const len = (w: Wall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  const between = (z1: string, z2: string) =>
    walls.filter((w) => !w.exterior && w.zones.includes(z1) && w.zones.includes(z2) && len(w) >= 1.1);
  const doors: Door[] = [];
  const addDoor = (w: W, width = 0.85, exit = false) =>
    doors.push({ id: `${prefix}d${doors.length}`, wallId: w.id, t: 0.5, width: Math.min(width, len(w) - 0.2), exit });

  // Connect every zone, starting from the hall (or the living room when there is no hall).
  const zones = [...new Set(rooms.map((r) => r.zone))];
  const start = zones.includes("hall") ? "hall" : zones.includes("base") ? "base" : zones[0];
  const reached = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const z of zones) {
      if (reached.has(z)) continue;
      const options = [...reached].flatMap((r) => between(z, r)).sort((a, b) => len(b) - len(a));
      if (options[0]) {
        addDoor(options[0]);
        reached.add(z);
        changed = true;
      }
    }
  }

  if (isGround) {
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const extOf = (zone: string, y: number) =>
      walls
        .filter((w) => w.exterior && w.zones.includes(zone) && w.a[1] === y && w.b[1] === y && len(w) >= 1.2)
        .sort((a, b) => len(b) - len(a))[0];
    const frontDoor = extOf("hall", yMin) ?? extOf("living", yMin);
    if (frontDoor) addDoor(frontDoor, 1.0, true);
    const backDoor = extOf("kitchen", yMax) ?? extOf("hall", yMax) ?? extOf("mud", yMax);
    if (backDoor) addDoor(backDoor, 0.9, true);
    const garageDoor = extOf("garage", yMin);
    if (garageDoor) addDoor(garageDoor, Math.min(4.8, len(garageDoor) - 0.6), true);
  }

  return { walls: walls.map((w) => ({ id: w.id, a: w.a, b: w.b, thickness: w.thickness, exterior: w.exterior })), doors };
}

const RISE: Record<RoofShape, (span: number) => number> = {
  gable: (s) => Math.min(4, Math.max(1.6, s * 0.33)),
  gambrel: (s) => Math.min(4.2, Math.max(2, s * 0.38)),
  hip: (s) => Math.min(3.4, Math.max(1.4, s * 0.28)),
  mansard: () => 2.4,
  flat: () => 0.5,
  other: (s) => Math.min(4, Math.max(1.6, s * 0.33)),
};

export type BuildInput = {
  id: string;
  source: BuildingModel["source"];
  confidence: number;
  address: string;
  lat: number;
  lng: number;
  /** Real outline in meters around (lat, lng), or null to use a default-sized house. */
  footprint: Point[] | null;
  /** Unit vector from the house toward the street, if known. */
  streetDir: Point | null;
  stories: number;
  basement: boolean;
  garage: GarageSide;
  roof: RoofShape;
};

export type BuildOutput = { model: BuildingModel; width: number; depth: number; facing: string; notes: string[] };

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

export function buildHouse(input: BuildInput): BuildOutput {
  const notes: string[] = [];
  const footprint: Point[] = input.footprint ?? [[-5.5, -4.5], [5.5, -4.5], [5.5, 4.5], [-5.5, 4.5]];
  const rect = minAreaRect(footprint);

  // Pick the side of the oriented rectangle that faces the street.
  const candidates: Point[] = [rect.u, [-rect.u[0], -rect.u[1]], rect.v, [-rect.v[0], -rect.v[1]]];
  const want: Point = input.streetDir ?? [0, -1];
  const f = candidates.sort((a, b) => b[0] * want[0] + b[1] * want[1] - (a[0] * want[0] + a[1] * want[1]))[0];
  const alongU = Math.abs(f[0] * rect.u[0] + f[1] * rect.u[1]) > 0.5;
  let width = alongU ? rect.wV : rect.wU;
  let depth = alongU ? rect.wU : rect.wV;
  if (width > 40 || depth > 40) notes.push("This building is larger than a typical house; the room layout is a rough guide only.");
  width = Math.min(40, Math.max(5, width));
  depth = Math.min(40, Math.max(5, depth));

  // Plan frame -> model frame. Plan -y is the front (toward the street).
  const xAxis: Point = [-f[1], f[0]];
  const yAxis: Point = [-f[0], -f[1]];
  const [cx, cy] = rect.center;
  const T = ([x, y]: Point): Point => [r4(cx + x * xAxis[0] + y * yAxis[0]), r4(cy + x * xAxis[1] + y * yAxis[1])];
  const rectPts = (r: Rect): Point[] => [T([r.x0, r.y0]), T([r.x1, r.y0]), T([r.x1, r.y1]), T([r.x0, r.y1])];

  const stories = Math.min(3, Math.max(1, Math.round(input.stories)));
  const plan = planHouse({ width, depth, stories, basement: input.basement, garage: input.garage }, notes);

  const floors: Floor[] = plan.map((pf) => {
    const prefix = pf.level < 0 ? "b-" : `f${pf.level}-`;
    const { walls, doors } = wallsAndDoors(prefix, pf.rooms, pf.level === 0);
    const stairs: Stairs[] = [];
    if (pf.stair) {
      const up = plan.some((p) => p.level === pf.level + 1);
      const down = plan.some((p) => p.level === pf.level - 1);
      if (up) stairs.push({ id: `${prefix}s-up`, polygon: rectPts(pf.stair), toLevel: pf.level + 1 });
      else if (down) stairs.push({ id: `${prefix}s-down`, polygon: rectPts(pf.stair), toLevel: pf.level - 1 });
    }
    return {
      level: pf.level,
      name: FLOOR_NAMES[pf.level] ?? `Level ${pf.level}`,
      elevation: pf.level < 0 ? -2.5 : pf.level * 2.8,
      height: pf.level < 0 ? 2.5 : 2.8,
      rooms: pf.rooms.map((r) => ({ id: `${prefix}${r.id}`, name: r.name, type: r.type, polygon: rectPts(r.r) })),
      walls: walls.map((w) => ({ ...w, a: T(w.a), b: T(w.b) })),
      doors,
      stairs,
    };
  });

  // The roof covers the main body (the garage strip is single story).
  const topRooms = plan[plan.length - 1].rooms;
  const bx0 = Math.min(...topRooms.map((r) => r.r.x0)), bx1 = Math.max(...topRooms.map((r) => r.r.x1));
  const [rcx, rcy] = T([(bx0 + bx1) / 2, 0]);
  const roofW = bx1 - bx0;
  const roof: Roof = {
    shape: input.roof,
    center: [rcx, rcy],
    width: roofW,
    depth,
    rotation: Math.atan2(xAxis[1], xAxis[0]),
    height: RISE[input.roof](Math.min(roofW, depth)),
  };

  const bearing = ((Math.atan2(f[0], f[1]) * 180) / Math.PI + 360) % 360;
  const facing = COMPASS[Math.round(bearing / 45) % 8];

  return {
    model: {
      id: input.id,
      source: input.source,
      confidence: input.confidence,
      address: input.address,
      lat: input.lat,
      lng: input.lng,
      footprint: footprint.map(([x, y]) => [r4(x), r4(y)] as Point),
      floors,
      markers: [],
      roof,
    },
    width,
    depth,
    facing,
    notes,
  };
}
