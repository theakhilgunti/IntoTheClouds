/**
 * Turns an Apple RoomPlan scan (the JSON of a CapturedRoom / CapturedStructure, from a LiDAR iPhone or
 * iPad) into real floors on a BuildingModel. Nothing here invents geometry: walls, doors, openings and
 * stairs are the measured surfaces. The only decisions we make are placement ones (where the scan sits
 * inside the mapped outline), and every uncertain one is reported in `notes` or refuses the scan.
 *
 * RoomPlan conventions used: each surface has `dimensions` [width, height, depth] and a column-major
 * 4x4 `transform`; local x runs along the surface, y is up, so the floor plane is (x, z).
 */
import { dist, distToRing, minAreaRect, nearestOnSegment, pointInPolygon, polygonArea, polygonCentroid } from "@/lib/geo";
import { summarizeInterior } from "@/lib/model/interior";
import type { BuildingModel, Door, Floor, Point, Room, RoomType, Stairs, Wall } from "@/packages/schema/building-model";

export type RoomPlanOptions = {
  /** "north": the scan frame came from ARKit gravityAndHeading (x east, z south), so placement is exact in rotation. */
  frame?: "north" | "arbitrary";
  /** Floor to use when the scan doesn't say (RoomPlan `story`). */
  level?: number;
  capturedAt?: string;
  capturedBy?: string;
};

export type RoomPlanResult =
  | { ok: true; model: BuildingModel; notes: string[]; roomCount: number }
  | { ok: false; reasons: string[] };

type Json = Record<string, unknown>;
type Surface = { cat: string; dims: number[]; m: number[][]; corners?: number[][]; label?: string };

const FLOOR_NAMES: Record<number, string> = { [-1]: "Basement", 0: "1st Floor", 1: "2nd Floor", 2: "3rd Floor" };
const LABEL_TYPES: Record<string, RoomType> = {
  kitchen: "kitchen", bedroom: "bedroom", bathroom: "bathroom", livingroom: "living", diningroom: "dining",
  office: "office", garage: "garage", stairs: "stair", laundryroom: "utility", closet: "closet", basement: "basement",
};

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every((n) => typeof n === "number") ? (v as number[]) : null);

/** simd_float4x4 encodes as 16 numbers or 4 columns of 4. Returns 4 columns. */
function matrix(v: unknown): number[][] | null {
  const flat = nums(v);
  if (flat && flat.length === 16) return [0, 1, 2, 3].map((c) => flat.slice(c * 4, c * 4 + 4));
  if (Array.isArray(v) && v.length === 4) {
    const cols = v.map(nums);
    if (cols.every((c) => c && c.length === 4)) return cols as number[][];
  }
  return null;
}

function catName(c: unknown): string {
  if (typeof c === "string") return c.toLowerCase();
  if (isObj(c)) return (Object.keys(c)[0] ?? "").toLowerCase();
  return "";
}

function surfaces(list: unknown): Surface[] {
  if (!Array.isArray(list)) return [];
  const out: Surface[] = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const dims = nums(s.dimensions), m = matrix(s.transform);
    if (!dims || dims.length < 3 || !m) continue;
    out.push({ cat: catName(s.category), dims, m, corners: Array.isArray(s.polygonCorners) ? (s.polygonCorners as number[][]) : undefined });
  }
  return out;
}

type ScanRoom = { story: number | null; walls: Surface[]; doors: Surface[]; floors: Surface[]; stairs: Surface[]; sections: { label: string; c: Point }[] };

function roomsOf(scan: unknown): ScanRoom[] {
  const raws = isObj(scan) && Array.isArray(scan.rooms) ? (scan.rooms as unknown[]) : [scan];
  return raws.filter(isObj).map((r) => ({
    story: typeof r.story === "number" ? r.story : null,
    walls: surfaces(r.walls),
    doors: [...surfaces(r.doors), ...surfaces(r.openings)],
    floors: surfaces(r.floors),
    stairs: surfaces(r.objects).filter((o) => o.cat === "stairs"),
    sections: Array.isArray(r.sections)
      ? (r.sections as unknown[]).filter(isObj).flatMap((s) => {
          const c = nums(s.center);
          return c && c.length >= 3 ? [{ label: catName(s.label), c: [c[0], -c[2]] as Point }] : [];
        })
      : [],
  }));
}

/** Scan frame (x, z) -> model frame (x east, y north). */
const flat = (x: number, z: number): Point => [x, -z];
const center = (s: Surface): Point => flat(s.m[3][0], s.m[3][2]);
const axis = (s: Surface): Point => {
  const d = flat(s.m[0][0], s.m[0][2]);
  const l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
};
const rotate = (p: Point, a: number, o: Point = [0, 0]): Point => [
  o[0] + (p[0] - o[0]) * Math.cos(a) - (p[1] - o[1]) * Math.sin(a),
  o[1] + (p[0] - o[0]) * Math.sin(a) + (p[1] - o[1]) * Math.cos(a),
];
/** Distance from p to the outline itself (distToRing is 0 anywhere inside). */
const edgeDist = (p: Point, ring: Point[]) => Math.min(...ring.map((a, i) => dist(p, nearestOnSegment(p, a, ring[(i + 1) % ring.length]))));
const round = (p: Point): Point => [Math.round(p[0] * 1e3) / 1e3, Math.round(p[1] * 1e3) / 1e3];

function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (pts: Point[]) => {
    const h: Point[] = [];
    for (const q of pts) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...build(p), ...build([...p].reverse())];
}

type Raw = {
  walls: { a: Point; b: Point; thick: number; story: number }[];
  doors: { c: Point; width: number; story: number }[];
  rooms: { poly: Point[]; type: RoomType; name: string; story: number }[];
  stairs: { poly: Point[]; story: number }[];
};

export function applyRoomPlan(model: BuildingModel, scan: unknown, opts: RoomPlanOptions = {}): RoomPlanResult {
  const rooms = roomsOf(scan);
  if (!rooms.length || rooms.every((r) => !r.walls.length)) {
    return { ok: false, reasons: ["This file has no wall surfaces. Send the JSON of a RoomPlan CapturedRoom or CapturedStructure."] };
  }
  const defaultLevel = opts.level ?? 0;
  const raw: Raw = { walls: [], doors: [], rooms: [], stairs: [] };
  rooms.forEach((r, ri) => {
    const story = r.story ?? defaultLevel;
    const w0 = raw.walls.length;
    for (const w of r.walls) {
      const c = center(w), d = axis(w), h = w.dims[0] / 2;
      raw.walls.push({ a: [c[0] - d[0] * h, c[1] - d[1] * h], b: [c[0] + d[0] * h, c[1] + d[1] * h], thick: Math.max(0.05, w.dims[2] || 0.1), story });
    }
    for (const d of r.doors) raw.doors.push({ c: center(d), width: Math.max(0.5, d.dims[0]), story });
    for (const s of r.stairs) {
      const c = center(s), d = axis(s), hw = s.dims[0] / 2, hd = s.dims[2] / 2, n: Point = [-d[1], d[0]];
      raw.stairs.push({ poly: [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([i, j]) => [c[0] + d[0] * hw * i + n[0] * hd * j, c[1] + d[1] * hw * i + n[1] * hd * j] as Point), story });
    }
    // Room outline: the measured floor polygon if the scan has one, else the hull of its walls.
    let poly: Point[] | null = null;
    const f = r.floors[0];
    if (f?.corners?.length && f.corners.length >= 3) {
      poly = f.corners.map((p) => {
        const x = f.m[0][0] * p[0] + f.m[1][0] * p[1] + f.m[2][0] * p[2] + f.m[3][0];
        const z = f.m[0][2] * p[0] + f.m[1][2] * p[1] + f.m[2][2] * p[2] + f.m[3][2];
        return flat(x, z);
      });
    }
    const wallPts = raw.walls.slice(w0).flatMap((w) => [w.a, w.b]);
    const outline = poly ?? hull(wallPts);
    if (outline.length >= 3 && polygonArea(outline) > 1) {
      const cen = polygonCentroid(outline);
      const near = r.sections.map((s) => ({ s, d: Math.hypot(s.c[0] - cen[0], s.c[1] - cen[1]) })).sort((a, b) => a.d - b.d)[0];
      const label = near && pointInPolygon(near.s.c, outline) ? near.s.label : "";
      raw.rooms.push({ poly: outline, type: LABEL_TYPES[label] ?? "other", name: label ? label.replace(/room$/, " room") : `Room ${ri + 1}`, story });
    }
  });

  // ---- placement: the scan has no map position, so fit it to the real outline and prove the fit.
  const notes: string[] = [];
  const pts = raw.walls.flatMap((w) => [w.a, w.b]);
  const fp = model.footprint;
  const fpC = polygonCentroid(fp);
  let angle = 0;
  if (opts.frame !== "north") {
    // Wall directions vote (mod 90°) for how the scan is turned relative to the outline's main axis.
    let sx = 0, sy = 0;
    for (const w of raw.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const th = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
      sx += len * Math.cos(4 * th);
      sy += len * Math.sin(4 * th);
    }
    const dominant = Math.atan2(sy, sx) / 4;
    const rect = minAreaRect(fp);
    angle = Math.atan2(rect.u[1], rect.u[0]) - dominant;
  }
  const scanC = polygonCentroid(hull(pts));
  const place = (p: Point, a: number): Point => {
    const q = rotate(p, a, scanC);
    return [q[0] - scanC[0] + fpC[0], q[1] - scanC[1] + fpC[1]];
  };
  const score = (a: number) => pts.filter((p) => { const q = place(p, a); return pointInPolygon(q, fp) || distToRing(q, fp) < 0.5; }).length / pts.length;
  const options = opts.frame === "north" ? [0] : [0, 1, 2, 3].map((k) => angle + (k * Math.PI) / 2);
  const scored = options.map((a) => ({ a, s: score(a) })).sort((p, q) => q.s - p.s);
  const best = scored[0];
  if (best.s < 0.8) {
    return {
      ok: false,
      reasons: [
        `Only ${Math.round(best.s * 100)}% of the scanned walls fit inside this building's mapped outline, so this scan may be of a different building, or the outline may be wrong.`,
      ],
    };
  }
  const area = polygonArea(hull(pts.map((p) => place(p, best.a))));
  if (area > polygonArea(fp) * 1.35) {
    return { ok: false, reasons: [`The scan covers about ${Math.round(area)} m² but the mapped outline is ${Math.round(polygonArea(fp))} m². It may be the wrong building.`] };
  }
  if (opts.frame === "north") {
    notes.push("Rotation is exact (the scan was captured with compass alignment). Position is centered on the outline.");
  } else if (scored.length > 1 && best.s - scored[1].s < 0.05) {
    notes.push("The scan has no compass, and it fits the outline in more than one turn. Check the entrance position: it may be turned 90° or 180°.");
  } else {
    notes.push("The scan has no compass; it was turned to fit the outline. Check that the entrance is on the right side.");
  }
  if (rooms.length === 1) notes.push("Only one room was scanned; the rest of this floor is unknown.");

  // ---- build floors
  const T = (p: Point) => round(place(p, best.a));
  const levels = [...new Set([...raw.rooms.map((r) => r.story), ...raw.walls.map((w) => w.story)])].sort((a, b) => a - b);
  let floors = [...model.floors];
  let roomCount = 0;
  for (const level of levels) {
    const prefix = level < 0 ? "b-" : `f${level}-`;
    const existing = floors.find((f) => f.level === level);
    const shellExterior = (existing?.walls ?? []).filter((w) => w.exterior);

    const inside: Wall[] = [];
    raw.walls.filter((w) => w.story === level).forEach((w, i) => {
      const a = T(w.a), b = T(w.b);
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const exterior = edgeDist(mid, fp) < 0.45;
      // Two rooms both report the wall they share; keep one.
      const twin = inside.some((o) => (dist(o.a, a) < 0.25 && dist(o.b, b) < 0.25) || (dist(o.a, b) < 0.25 && dist(o.b, a) < 0.25));
      if (!exterior && !twin) inside.push({ id: `${prefix}m${i}`, a, b, thickness: Math.round(w.thick * 100) / 100, exterior: false });
    });
    const allWalls = [...shellExterior, ...inside];

    const doors: Door[] = [];
    for (const d of raw.doors.filter((x) => x.story === level)) {
      const c = T(d.c);
      let bi = -1, bd = Infinity, bt = 0.5;
      allWalls.forEach((w, i) => {
        const vx = w.b[0] - w.a[0], vy = w.b[1] - w.a[1], l2 = vx * vx + vy * vy;
        if (l2 < 1e-6) return;
        const t = Math.min(1, Math.max(0, ((c[0] - w.a[0]) * vx + (c[1] - w.a[1]) * vy) / l2));
        const dd = Math.hypot(c[0] - (w.a[0] + t * vx), c[1] - (w.a[1] + t * vy));
        if (dd < bd) { bd = dd; bi = i; bt = t; }
      });
      if (bi < 0 || bd > 0.6) { notes.push("One scanned door or opening didn't line up with any wall and was left out."); continue; }
      const w = allWalls[bi], len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (doors.some((o) => o.wallId === w.id && Math.abs(o.t - bt) * len < 0.4)) continue; // the same door, scanned from both rooms
      doors.push({ id: `${prefix}d${doors.length}`, wallId: w.id, t: Math.min(0.95, Math.max(0.05, bt)), width: Math.min(d.width, len), exit: w.exterior });
    }
    const outRooms: Room[] = raw.rooms.filter((r) => r.story === level).map((r, i) => ({ id: `${prefix}r${i}`, name: r.name, type: r.type, polygon: r.poly.map(T) }));
    roomCount += outRooms.length;
    const up = floors.some((f) => f.level === level + 1);
    const stairs: Stairs[] = raw.stairs.filter((s) => s.story === level).map((s, i) => ({ id: `${prefix}s${i}`, polygon: s.poly.map(T), toLevel: up ? level + 1 : level - 1 }));
    if (stairs.length) notes.push("The scanner records where stairs are but not which way they go; direction is assumed.");

    const floor: Floor = {
      level,
      name: existing?.name ?? FLOOR_NAMES[level] ?? `Level ${level}`,
      elevation: existing?.elevation ?? (level < 0 ? -2.5 : level * 2.8),
      height: existing?.height ?? (level < 0 ? 2.5 : 2.8),
      rooms: outRooms, walls: allWalls, doors, stairs,
    };
    floors = [...floors.filter((f) => f.level !== level), floor];
  }
  floors.sort((a, b) => a.level - b.level);

  const scannedArea = raw.rooms.reduce((s, r) => s + polygonArea(r.poly), 0);
  const perFloor = polygonArea(fp);
  if (scannedArea < perFloor * levels.length * 0.7) {
    notes.push(`The scan covers about ${Math.round((scannedArea / (perFloor * levels.length)) * 100)}% of the floor area. Unscanned areas are unknown, not empty.`);
  }
  const interior = {
    ...summarizeInterior(floors, model.interior, notes, "LiDAR scan (Apple RoomPlan)"),
    capturedAt: opts.capturedAt,
    capturedBy: opts.capturedBy,
  };
  return { ok: true, model: { ...model, source: "upload", floors, interior }, notes, roomCount };
}
