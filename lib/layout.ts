/**
 * Layout engine: turns "what we know about the house" (footprint, floors, garage, roof)
 * into a BuildingModel with rooms, walls, doors and stairs.
 *
 * Interior rooms are an estimate: no public data source has real floor plans, so we lay out
 * a typical American house plan, then cut it to the mapped footprint. Walls follow that
 * outline, so the shell matches the yellow line instead of the bounding rectangle.
 *
 * Plan frame: meters, house centered at 0,0, front of the house at -y, +x on your right
 * when you stand on the street looking at the front door.
 */
import type {
  BuildingModel, Door, Floor, Point, Roof, RoofPlan, RoofShape, RoomType, Stairs, Wall,
} from "@/packages/schema/building-model";
import { minAreaRect } from "./geo";
import { roomBays } from "./compound-geom";
import { clipPolyToRect, signedArea, wallsAlongOutline, type OutlineWall } from "./outline";

type Rect = { x0: number; y0: number; x1: number; y1: number };
type PlanRoom = { id: string; name: string; type: RoomType; r: Rect; zone: string };
type PlanFloor = { level: number; rooms: PlanRoom[]; stair: Rect | null };

export type GarageSide = "none" | "left" | "right";

/** Interior program — OSM building=* when known. */
export type BuildingUse = "house" | "school" | "office" | "church" | "commercial";

export function buildingUseFromTag(tag: string | undefined | null): BuildingUse {
  const t = (tag ?? "").toLowerCase().trim();
  if (!t || t === "yes" || t === "house" || t === "detached" || t === "semidetached_house" || t === "terrace" || t === "bungalow" || t === "static_caravan" || t === "residential") {
    return "house";
  }
  if (t === "school" || t === "kindergarten" || t === "university" || t === "college" || t === "college_building") return "school";
  if (t === "church" || t === "cathedral" || t === "chapel" || t === "mosque" || t === "synagogue" || t === "temple" || t === "place_of_worship") {
    return "church";
  }
  if (t === "office" || t === "commercial" || t === "retail" || t === "supermarket" || t === "warehouse" || t === "industrial" || t === "public") {
    return t === "office" ? "office" : "commercial";
  }
  if (t === "apartments" || t === "dormitory" || t === "hotel") return "house";
  return "house";
}

export type HouseSpec = {
  width: number; // across the front
  depth: number; // front to back
  stories: number; // above ground, 1..3
  basement: boolean;
  garage: GarageSide;
  /** Which side the driveway is on, as you stand on the street looking at the front door. */
  drivewaySide: "left" | "right" | null;
  use?: BuildingUse;
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

  // Hall band: a center hall for wide houses, a side hall for narrow ones.
  // The side hall sits on the driveway so that side has the door and the other side has the windows.
  const center = Wm >= 8.5;
  let hx0: number, hx1: number, rx0: number, rx1: number, front: number;
  if (center) {
    const mid = (mx0 + mx1) / 2;
    hx0 = mid - 1.2; hx1 = mid + 1.2;
    rx0 = mx0; rx1 = mx1;
    front = y0 + D * 0.5;
  } else if (spec.drivewaySide === "left") {
    const hallW = Math.min(1.3, Wm * 0.25);
    hx0 = mx0; hx1 = mx0 + hallW;
    rx0 = hx1; rx1 = mx1;
    front = y0 + D * 0.36;
  } else {
    const hallW = Math.min(1.3, Wm * 0.25);
    hx1 = mx1; hx0 = mx1 - hallW;
    rx0 = mx0; rx1 = hx0;
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

  const bays = roomBays(D);
  const edges = bayEdges(y0, D, bays);
  const column = (i: number): Rect => ({ x0: rx0, y0: edges[i], x1: rx1, y1: edges[i + 1] });

  // Ground floor. Bay count follows how many windows fit down the long side.
  const g: PlanRoom[] = [...garageRooms, ...hallPieces("g-", "Front Hall")];
  if (center) {
    g.push(
      { id: "living", name: "Living Room", type: "living", r: { x0: mx0, y0, x1: hx0, y1: front }, zone: "living" },
      { id: "dining", name: "Dining Room", type: "dining", r: { x0: hx1, y0, x1: mx1, y1: front }, zone: "dining" },
      { id: "family", name: "Family Room", type: "living", r: { x0: mx0, y0: front, x1: hx0, y1 }, zone: "family" },
      { id: "kitchen", name: "Kitchen", type: "kitchen", r: { x0: hx1, y0: front, x1: mx1, y1 }, zone: "kitchen" },
    );
    const kitchen = g.find((r) => r.id === "kitchen");
    if (kitchen && D >= 13 && kitchen.r.y1 - kitchen.r.y0 > 4.2) {
      const cut = kitchen.r.y1 - 2.3;
      g.push({ id: "powder", name: "Powder Room", type: "bathroom", r: { x0: kitchen.r.x0, y0: cut, x1: kitchen.r.x1, y1: kitchen.r.y1 }, zone: "powder" });
      kitchen.r = { ...kitchen.r, y1: cut };
    }
  } else {
    const groundPlan: { id: string; name: string; type: RoomType }[] =
      bays === 2
        ? [
            { id: "living", name: "Living Room", type: "living" },
            { id: "kitchen", name: "Kitchen", type: "kitchen" },
          ]
        : bays === 3
          ? [
              { id: "living", name: "Living Room", type: "living" },
              { id: "dining", name: "Dining Room", type: "dining" },
              { id: "kitchen", name: "Kitchen", type: "kitchen" },
            ]
          : [
              { id: "living", name: "Living Room", type: "living" },
              { id: "dining", name: "Dining Room", type: "dining" },
              { id: "powder", name: "Powder Room", type: "bathroom" },
              { id: "kitchen", name: "Kitchen", type: "kitchen" },
            ];
    groundPlan.forEach((room, i) => {
      g.push({ ...room, r: column(i), zone: room.id });
    });
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
      const upper: { kind: "bed" | "bath" }[] =
        bays === 2 ? [{ kind: "bed" }, { kind: "bed" }]
          : bays === 3 ? [{ kind: "bed" }, { kind: "bath" }, { kind: "bed" }]
            : [{ kind: "bed" }, { kind: "bed" }, { kind: "bath" }, { kind: "bed" }];
      // Two bays still need a bathroom, taken off the back of the rear bedroom.
      upper.forEach((slot, i) => {
        if (slot.kind === "bath") {
          u.push({ id: `${p}bath`, name: "Bathroom", type: "bathroom", r: column(i), zone: `${p}bath` });
        } else {
          u.push(bed(`${p}bed${i}`, column(i)));
        }
      });
      if (!upper.some((slot) => slot.kind === "bath")) {
        const rear = [...u].reverse().find((room) => room.type === "bedroom");
        if (rear && rear.r.y1 - rear.r.y0 > 3.4) {
          const cut = rear.r.y1 - 2.2;
          u.push({ id: `${p}bath`, name: "Bathroom", type: "bathroom", r: { ...rear.r, y0: cut }, zone: `${p}bath` });
          rear.r = { ...rear.r, y1: cut };
        }
      }
    }
    floors.push({ level: lv, rooms: u, stair });
  }

  if (spec.stories === 1) {
    const fam = g.find((r) => r.id === "family" || r.id === "dining");
    if (fam) Object.assign(fam, { name: "Primary Bedroom", type: "bedroom" as RoomType });
  }

  const above = floors.filter((f) => f.level >= 0);
  const beds = above.reduce((n, f) => n + f.rooms.filter((r) => r.type === "bedroom").length, 0);
  const baths = above.reduce((n, f) => n + f.rooms.filter((r) => r.type === "bathroom").length, 0);
  notes.push(
    `About ${bays} windows fit along the long side, so each floor is ${bays} rooms: ${beds} bedroom${beds === 1 ? "" : "s"} and ${baths} bath${baths === 1 ? "" : "s"}. ` +
      `The front door faces the street and the back door is at the kitchen${spec.drivewaySide ? ", with a side door toward the driveway" : ""}.`,
  );

  // Basement: open space with the stairs and a utility room (breaker panel, furnace, water heater).
  if (spec.basement) {
    const b: PlanRoom[] = [
      { id: "b-stair", name: "Basement Stairs", type: "stair", r: stair!, zone: "base" },
      { id: "b-hallF", name: "Basement", type: "basement", r: { x0: hx0, y0, x1: hx1, y1: front }, zone: "base" },
      { id: "b-main", name: "Basement", type: "basement", r: { x0: center ? mx0 : rx0, y0, x1: center ? hx0 : rx1, y1 }, zone: "base" },
    ];
    if (stairEnd < y1 - 0.3) b.push({ id: "b-hallB", name: "Basement", type: "basement", r: { x0: hx0, y0: stairEnd, x1: hx1, y1 }, zone: "base" });
    if (center) b.push({ id: "b-util", name: "Utility / Breaker Panel", type: "utility", r: { x0: hx1, y0, x1: mx1, y1 }, zone: "util" });
    else {
      const main = b.find((r) => r.id === "b-main")!;
      main.r = { ...main.r, y1: y0 + D * 0.7 };
      b.push({ id: "b-util", name: "Utility / Breaker Panel", type: "utility", r: { x0: rx0, y0: y0 + D * 0.7, x1: rx1, y1 }, zone: "util" });
    }
    floors.unshift({ level: -1, rooms: b, stair });
  }
  return floors;
}

/** Double-loaded corridor with classrooms — typical school wing. */
function planSchool(spec: HouseSpec, notes: string[]): PlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const hallW = Math.min(2.4, Math.max(1.6, W * 0.12));
  const mid = 0;
  const hx0 = mid - hallW / 2, hx1 = mid + hallW / 2;
  const hasStairs = spec.stories > 1;
  const stairLen = Math.min(STAIR_LEN, D * 0.2);
  const front = y0 + Math.min(5, D * 0.18);
  const stair: Rect | null = hasStairs ? { x0: hx0, y0: front, x1: hx1, y1: front + stairLen } : null;
  const floors: PlanFloor[] = [];

  const classRows = Math.max(2, Math.min(5, Math.round(D / 8)));
  const edges = Array.from({ length: classRows + 1 }, (_, i) => y0 + (D * i) / classRows);

  for (let lv = 0; lv < spec.stories; lv++) {
    const prefix = lv === 0 ? "s" : `s${lv}`;
    const rooms: PlanRoom[] = [
      { id: `${prefix}-hall`, name: "Main Hall", type: "hallway", r: { x0: hx0, y0, x1: hx1, y1 }, zone: "hall" },
    ];
    if (stair) rooms.push({ id: `${prefix}-stair`, name: "Stairs", type: "stair", r: stair, zone: "hall" });
    if (lv === 0) {
      rooms.push(
        { id: `${prefix}-office`, name: "Main Office", type: "office", r: { x0, y0, x1: hx0, y1: front }, zone: "admin" },
        { id: `${prefix}-nurse`, name: "Nurse / Counselor", type: "office", r: { x0: hx1, y0, x1, y1: front }, zone: "nurse" },
      );
    }
    let classNo = 1;
    for (let i = 0; i < classRows; i++) {
      const yA = Math.max(edges[i], lv === 0 ? front : y0);
      const yB = edges[i + 1];
      if (yB - yA < 2.2) continue;
      // Skip the stair band on the hall strip — classrooms sit left/right of the corridor.
      rooms.push({
        id: `${prefix}-cL${i}`,
        name: `Classroom ${lv + 1}${String(classNo).padStart(2, "0")}`,
        type: "other",
        r: { x0, y0: yA, x1: hx0, y1: yB },
        zone: `cL${i}`,
      });
      classNo++;
      rooms.push({
        id: `${prefix}-cR${i}`,
        name: `Classroom ${lv + 1}${String(classNo).padStart(2, "0")}`,
        type: "other",
        r: { x0: hx1, y0: yA, x1, y1: yB },
        zone: `cR${i}`,
      });
      classNo++;
    }
    // Rear specials on ground floor when deep enough; restrooms sit mid-hall otherwise at the back.
    if (lv === 0 && D >= 22) {
      const rear = y1 - Math.min(7, D * 0.22);
      rooms.push(
        { id: `${prefix}-cafe`, name: "Cafeteria", type: "other", r: { x0, y0: rear, x1: hx0, y1 }, zone: "cafe" },
        { id: `${prefix}-gym`, name: "Gym / Multi-purpose", type: "other", r: { x0: hx1, y0: rear, x1, y1 }, zone: "gym" },
        {
          id: `${prefix}-bath`,
          name: "Restrooms",
          type: "bathroom",
          r: { x0: hx0, y0: rear - 3.2, x1: hx1, y1: rear },
          zone: "bath",
        },
      );
    } else if (lv === 0) {
      rooms.push(
        { id: `${prefix}-bathL`, name: "Restrooms", type: "bathroom", r: { x0, y0: y1 - 3.2, x1: x0 + Math.min(4, W * 0.2), y1 }, zone: "bathL" },
        { id: `${prefix}-bathR`, name: "Restrooms", type: "bathroom", r: { x0: x1 - Math.min(4, W * 0.2), y0: y1 - 3.2, x1, y1 }, zone: "bathR" },
      );
    }
    floors.push({ level: lv, rooms, stair });
  }
  notes.push(
    `School-style layout: a center hall with classrooms on both sides` +
      (spec.stories > 1 ? ` across ${spec.stories} floors` : "") +
      `. Rooms are a typical wing plan, not a measured floor plan.`,
  );
  return floors;
}

/** Lobby + open work areas + meeting rooms — office / commercial. */
function planOffice(spec: HouseSpec, notes: string[], commercial: boolean): PlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const lobbyD = Math.min(6, Math.max(3.5, D * 0.22));
  const hasStairs = spec.stories > 1;
  const hx0 = -1.1, hx1 = 1.1;
  const stair: Rect | null = hasStairs
    ? { x0: hx0, y0: y0 + lobbyD, x1: hx1, y1: y0 + lobbyD + Math.min(STAIR_LEN, D * 0.18) }
    : null;
  const floors: PlanFloor[] = [];
  for (let lv = 0; lv < spec.stories; lv++) {
    const prefix = `o${lv}`;
    const rooms: PlanRoom[] = [];
    if (lv === 0) {
      rooms.push({ id: `${prefix}-lobby`, name: commercial ? "Sales Floor / Lobby" : "Lobby", type: "hallway", r: { x0, y0, x1, y1: y0 + lobbyD }, zone: "lobby" });
    } else {
      rooms.push({ id: `${prefix}-hall`, name: "Elevator Lobby", type: "hallway", r: { x0: hx0 - 1, y0, x1: hx1 + 1, y1: y0 + 4 }, zone: "hall" });
    }
    if (stair) rooms.push({ id: `${prefix}-stair`, name: "Stairs", type: "stair", r: stair, zone: "hall" });
    const workY0 = lv === 0 ? y0 + lobbyD : y0 + 4;
    const midY = (workY0 + y1) / 2;
    rooms.push(
      { id: `${prefix}-openL`, name: commercial ? "Retail / Open Area" : "Open Office", type: "office", r: { x0, y0: workY0, x1: 0, y1: midY }, zone: "openL" },
      { id: `${prefix}-openR`, name: commercial ? "Stock / Open Area" : "Open Office", type: "office", r: { x0: 0, y0: workY0, x1, y1: midY }, zone: "openR" },
      { id: `${prefix}-meet`, name: "Conference / Meeting", type: "office", r: { x0, y0: midY, x1: hx0, y1 }, zone: "meet" },
      { id: `${prefix}-break`, name: commercial ? "Back Office" : "Break Room", type: "utility", r: { x0: hx1, y0: midY, x1, y1 }, zone: "break" },
      { id: `${prefix}-bath`, name: "Restrooms", type: "bathroom", r: { x0: hx0, y0: midY, x1: hx1, y1: midY + Math.min(3.5, (y1 - midY) * 0.5) }, zone: "bath" },
    );
    floors.push({ level: lv, rooms, stair });
  }
  notes.push(
    `${commercial ? "Commercial" : "Office"}-style layout: lobby/sales at the front and open work areas behind. Estimated, not measured.`,
  );
  return floors;
}

/** Nave + side rooms — place of worship. */
function planChurch(spec: HouseSpec, notes: string[]): PlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const narthex = y0 + Math.min(4.5, D * 0.15);
  const chancel = y1 - Math.min(5, D * 0.18);
  const rooms: PlanRoom[] = [
    { id: "narthex", name: "Entrance / Narthex", type: "hallway", r: { x0, y0, x1, y1: narthex }, zone: "narthex" },
    { id: "nave", name: "Nave / Sanctuary", type: "other", r: { x0: x0 + W * 0.08, y0: narthex, x1: x1 - W * 0.08, y1: chancel }, zone: "nave" },
    { id: "chancel", name: "Chancel / Altar", type: "other", r: { x0: x0 + W * 0.15, y0: chancel, x1: x1 - W * 0.15, y1 }, zone: "chancel" },
    { id: "aisleL", name: "Side Aisle", type: "hallway", r: { x0, y0: narthex, x1: x0 + W * 0.08, y1: chancel }, zone: "aisleL" },
    { id: "aisleR", name: "Side Aisle", type: "hallway", r: { x0: x1 - W * 0.08, y0: narthex, x1, y1: chancel }, zone: "aisleR" },
    { id: "sacristy", name: "Office / Sacristy", type: "office", r: { x0, y0: chancel, x1: x0 + W * 0.15, y1 }, zone: "sacristy" },
    { id: "choir", name: "Vestry / Choir", type: "other", r: { x0: x1 - W * 0.15, y0: chancel, x1, y1 }, zone: "choir" },
  ];
  notes.push("Church-style layout: entrance, nave, and chancel. Estimated worship plan, not a measured survey.");
  return [{ level: 0, rooms, stair: null }];
}

function planBuilding(spec: HouseSpec, notes: string[]): PlanFloor[] {
  const use = spec.use ?? "house";
  if (use === "school") return planSchool(spec, notes);
  if (use === "office") return planOffice(spec, notes, false);
  if (use === "commercial") return planOffice(spec, notes, true);
  if (use === "church") return planChurch({ ...spec, stories: 1, basement: false }, notes);
  return planHouse(spec, notes);
}

function bayEdges(y0: number, depth: number, n: number): number[] {
  const frac = n === 4 ? [0, 0.3, 0.54, 0.7, 1] : n === 3 ? [0, 0.36, 0.66, 1] : [0, 0.55, 1];
  return frac.map((t) => y0 + depth * t);
}

type ZWall = Wall & { zones: [string, string | null] };

/** Doors on walls that already follow the outline. Front and back are the long edges; the side door faces the driveway. */
function placeDoors(prefix: string, raw: OutlineWall[], zones: string[], isGround: boolean, drivewaySide: "left" | "right" | null) {
  const walls: ZWall[] = raw.map((w, i) => ({
    id: `${prefix}w${i}`,
    a: w.a,
    b: w.b,
    thickness: w.exterior ? 0.25 : 0.12,
    exterior: w.exterior,
    zones: w.zones,
  }));
  const len = (w: Wall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  const mid = (w: Wall): Point => [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
  const across = (w: Wall) => Math.abs(w.b[0] - w.a[0]) >= Math.abs(w.b[1] - w.a[1]);
  const between = (z1: string, z2: string) =>
    walls.filter((w) => !w.exterior && w.zones.includes(z1) && w.zones.includes(z2) && len(w) >= 0.7);
  const doors: Door[] = [];
  const addDoor = (w: ZWall, width = 0.85, exit = false) =>
    doors.push({ id: `${prefix}d${doors.length}`, wallId: w.id, t: 0.5, width: Math.min(width, Math.max(0.6, len(w) - 0.2)), exit });

  const start = zones.includes("hall") ? "hall" : zones.includes("base") ? "base" : zones[0];
  const reached = new Set(start ? [start] : []);
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
    const ext = walls.filter((w) => w.exterior && len(w) >= 1.05);
    const pick = (pred: (w: ZWall) => boolean, score: (w: ZWall) => number) =>
      ext.filter(pred).sort((a, b) => score(a) - score(b))[0];
    const frontDoor = pick((w) => across(w) && (w.zones.includes("hall") || w.zones.includes("living")), (w) => mid(w)[1]);
    if (frontDoor) addDoor(frontDoor, 1.0, true);
    const backDoor = pick(
      (w) => across(w) && w !== frontDoor && (w.zones.includes("kitchen") || w.zones.includes("hall") || w.zones.includes("mud")),
      (w) => -mid(w)[1],
    );
    if (backDoor) addDoor(backDoor, 0.9, true);
    const garageDoor = pick((w) => across(w) && w.zones.includes("garage"), (w) => mid(w)[1]);
    if (garageDoor) addDoor(garageDoor, Math.min(4.8, len(garageDoor) - 0.2), true);
    if (drivewaySide) {
      const sideWalls = ext.filter((w) => !across(w));
      const preferred = sideWalls.filter((w) => w.zones.includes("kitchen") || w.zones.includes("hall"));
      const pool = preferred.length ? preferred : sideWalls;
      const sideDoor = pool.sort((a, b) => (drivewaySide === "right" ? mid(b)[0] - mid(a)[0] : mid(a)[0] - mid(b)[0]))[0];
      if (sideDoor && sideDoor !== frontDoor && sideDoor !== backDoor) addDoor(sideDoor, 0.9, true);
    }
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
  /** Which plan axis the ridge runs along. Defaults to the longer side. */
  ridgeAlong?: "width" | "depth";
  /** Inferred ridge-line / multi-wing plan in the model frame. */
  roofPlan?: RoofPlan | null;
  /** Garage centroid in the model frame, used to put the hall and side door on the driveway side. */
  garageAt?: Point | null;
  /** Interior program from OSM building=* (house, school, office, …). */
  use?: BuildingUse;
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
  if (width > 60 || depth > 60) notes.push("This building is larger than a typical house; the room layout is a rough guide only.");
  // Keep the real footprint scale so large compounds still get a full shell.
  width = Math.min(120, Math.max(5, width));
  depth = Math.min(120, Math.max(5, depth));

  // Plan frame -> model frame. Plan -y is the front (toward the street).
  const xAxis: Point = [-f[1], f[0]];
  const yAxis: Point = [-f[0], -f[1]];
  const [cx, cy] = rect.center;
  const T = ([x, y]: Point): Point => [r4(cx + x * xAxis[0] + y * yAxis[0]), r4(cy + x * xAxis[1] + y * yAxis[1])];
  const inv = ([x, y]: Point): Point => {
    const dx = x - cx, dy = y - cy;
    return [dx * xAxis[0] + dy * xAxis[1], dx * yAxis[0] + dy * yAxis[1]] as Point;
  };
  const fpPlan = footprint.map(inv);

  const stories = Math.min(3, Math.max(1, Math.round(input.stories)));
  let drivewaySide: "left" | "right" | null = null;
  if (input.garageAt) {
    const s = input.garageAt[0] * xAxis[0] + input.garageAt[1] * xAxis[1];
    if (Math.abs(s) > 0.4) drivewaySide = s > 0 ? "right" : "left";
  }
  const use = input.use ?? "house";
  const plan = planBuilding(
    {
      width,
      depth,
      stories: use === "church" ? 1 : stories,
      basement: use === "house" ? input.basement : false,
      garage: use === "house" ? input.garage : "none",
      drivewaySide: use === "house" ? drivewaySide : null,
      use,
    },
    notes,
  );

  const floors: Floor[] = plan.map((pf) => {
    const prefix = pf.level < 0 ? "b-" : `f${pf.level}-`;
    const rectPoly = (r: Rect): Point[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    const cut = pf.rooms
      .map((r) => ({ ...r, poly: clipPolyToRect(fpPlan, r.r) }))
      .filter((r) => r.poly.length >= 3 && Math.abs(signedArea(r.poly)) >= 0.3);
    const rooms = cut.length ? cut : pf.rooms.map((r) => ({ ...r, poly: rectPoly(r.r) }));
    const { walls, doors } = placeDoors(
      prefix,
      wallsAlongOutline(rooms.map((r) => ({ zone: r.zone, poly: r.poly }))),
      [...new Set(rooms.map((r) => r.zone))],
      pf.level === 0,
      drivewaySide,
    );
    const stairs: Stairs[] = [];
    const stairPoly = rooms.find((r) => r.type === "stair")?.poly;
    if (stairPoly && pf.stair) {
      const up = plan.some((p) => p.level === pf.level + 1);
      const down = plan.some((p) => p.level === pf.level - 1);
      if (up) stairs.push({ id: `${prefix}s-up`, polygon: stairPoly.map(T), toLevel: pf.level + 1 });
      else if (down) stairs.push({ id: `${prefix}s-down`, polygon: stairPoly.map(T), toLevel: pf.level - 1 });
    }
    return {
      level: pf.level,
      name: FLOOR_NAMES[pf.level] ?? `Level ${pf.level}`,
      elevation: pf.level < 0 ? -2.5 : pf.level * 2.8,
      height: pf.level < 0 ? 2.5 : 2.8,
      rooms: rooms.map((r) => ({ id: `${prefix}${r.id}`, name: r.name, type: r.type, polygon: r.poly.map(T) })),
      walls: walls.map((w) => ({ ...w, a: T(w.a), b: T(w.b) })),
      doors,
      stairs,
    };
  });

  // Roof eaves follow the mapped outline. An attached garage strip stays single-story (no roof over it).
  const topRooms = plan[plan.length - 1].rooms;
  const mainTop = topRooms.filter((r) => r.zone !== "garage" && r.zone !== "mud");
  const body = mainTop.length ? mainTop : topRooms;
  const bx0 = Math.min(...body.map((r) => r.r.x0)), bx1 = Math.max(...body.map((r) => r.r.x1));
  const by0 = Math.min(...body.map((r) => r.r.y0)), by1 = Math.max(...body.map((r) => r.r.y1));
  const roofPolyPlan = clipPolyToRect(fpPlan, { x0: bx0, y0: by0, x1: bx1, y1: by1 });
  const roofPoly = (roofPolyPlan.length >= 3 ? roofPolyPlan : fpPlan).map(T);
  const rcx = roofPoly.reduce((s, p) => s + p[0], 0) / roofPoly.length;
  const rcy = roofPoly.reduce((s, p) => s + p[1], 0) / roofPoly.length;
  const roofW = bx1 - bx0;
  const roofD = by1 - by0;
  const ridgeAlong = input.ridgeAlong ?? (roofD >= roofW ? "depth" : "width");
  const planHeight = input.roofPlan?.wings.reduce((m, w) => Math.max(m, w.height), 0) ?? 0;
  const roof: Roof = {
    shape: input.roof,
    center: [r4(rcx), r4(rcy)],
    width: Math.max(1, roofW),
    depth: Math.max(1, roofD),
    rotation: Math.atan2(xAxis[1], xAxis[0]),
    height: planHeight > 0 ? planHeight : RISE[input.roof](Math.min(roofW, roofD)),
    polygon: roofPoly.map(([x, y]) => [r4(x), r4(y)] as Point),
    ridgeAlong,
    plan: input.roofPlan ?? undefined,
    // Bump when flat/concave roof inference or mesh changes so cached scans rebuild.
    basis: "roof-v3",
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
