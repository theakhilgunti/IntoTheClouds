/**
 * Hose-lay planner: hydrant → Alpha-side entry stretch for firefighters.
 * Paths prefer mapped road/driveway centerlines; fall back to a straight lay.
 */
import type { BuildingModel, CompoundFeature, Point } from "../packages/schema/building-model";

export type HoseLay = {
  hydrantId: string;
  hydrantPos: [number, number];
  entryPos: [number, number]; // Alpha entry (front exit door outside or entry marker)
  path: [number, number][]; // polyline in model XY (y = north)
  lengthM: number;
  lengthFt: number;
  loadHint: "200ft" | "300ft" | "long"; // ≤61m → 200ft, ≤91m → 300ft, else long
  rank: number; // 0 = best
};

const M_TO_FT = 3.280839895;
const LOAD_200_M = 61;
const LOAD_300_M = 91;
const DEFAULT_MAX = 3;
/** Connect nearby road/driveway centerline endpoints into one walkable graph. */
const ROAD_JOIN_M = 8;

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function centroid(ring: Point[]): Point {
  const n = ring.length || 1;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

function pathLength(pts: Point[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1]!, pts[i]!);
  return L;
}

function loadHintFor(lengthM: number): HoseLay["loadHint"] {
  if (lengthM <= LOAD_200_M) return "200ft";
  if (lengthM <= LOAD_300_M) return "300ft";
  return "long";
}

function dedupePath(pts: Point[], eps = 0.05): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > eps) out.push([p[0], p[1]]);
  }
  return out;
}

/** Closest point on segment a→b to p, plus distance. */
function closestOnSeg(p: Point, a: Point, b: Point): { pt: Point; d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const pt: Point = [a[0] + t * dx, a[1] + t * dy];
  return { pt, d: dist(p, pt), t };
}

/**
 * Road/driveway ribbons are 4-gons [aL, bL, bR, aR] → centerline mid(aL,aR)→mid(bL,bR).
 * Longer rings fall back to sequential vertices (skip closing duplicate).
 */
export function featureCenterline(poly: Point[]): Point[] {
  if (poly.length === 4) {
    const a: Point = [(poly[0]![0] + poly[3]![0]) / 2, (poly[0]![1] + poly[3]![1]) / 2];
    const b: Point = [(poly[1]![0] + poly[2]![0]) / 2, (poly[1]![1] + poly[2]![1]) / 2];
    if (dist(a, b) < 0.2) return [a];
    return [a, b];
  }
  if (poly.length < 2) return poly.length ? [[poly[0]![0], poly[0]![1]]] : [];
  const pts = poly.map((p) => [p[0], p[1]] as Point);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (dist(first, last) < 0.15 && pts.length > 2) pts.pop();
  return pts;
}

function collectHydrants(model: BuildingModel): Array<{ id: string; pos: Point }> {
  const feats = model.compound?.features.filter((f) => f.kind === "hydrant") ?? [];
  return feats.map((f) => ({ id: f.id, pos: centroid(f.polygon) }));
}

/** Direction from house center toward nearest mapped road vertex (plan east/north). */
function nearestStreetDir(model: BuildingModel): Point | null {
  const roads = model.compound?.features.filter((f) => f.kind === "road") ?? [];
  if (!roads.length) return null;
  const fp = model.footprint;
  const cx = fp.reduce((s, p) => s + p[0], 0) / (fp.length || 1);
  const cy = fp.reduce((s, p) => s + p[1], 0) / (fp.length || 1);
  let bestD = Infinity;
  let best: Point | null = null;
  for (const r of roads) {
    for (const [x, y] of r.polygon) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [x - cx, y - cy];
      }
    }
  }
  if (!best) return null;
  const len = Math.hypot(best[0], best[1]) || 1;
  return [best[0] / len, best[1] / len];
}

type ExitCand = {
  at: Point;
  outside: Point;
  named: boolean;
  streetDot: number;
  atY: number;
};

/**
 * Alpha entry: prefer entry marker; else level-0 exit facing nearest road;
 * else southernmost exit. Position is outside the door (or the marker itself).
 */
export function findAlphaEntry(model: BuildingModel): Point | null {
  const entry = model.markers.find((m) => m.type === "entry");
  if (entry) return [entry.pos[0], entry.pos[1]];

  const street = nearestStreetDir(model);
  const floor =
    model.floors.find((f) => f.level === 0 && f.doors.some((d) => d.exit)) ??
    model.floors.find((f) => f.level >= 0 && f.doors.some((d) => d.exit)) ??
    model.floors.find((f) => f.doors.some((d) => d.exit));
  if (!floor) return null;

  const fp = model.footprint;
  const cx = fp.reduce((s, p) => s + p[0], 0) / (fp.length || 1);
  const cy = fp.reduce((s, p) => s + p[1], 0) / (fp.length || 1);
  const roomPts = floor.rooms.flatMap((r) => r.polygon);
  const mid: Point = roomPts.length
    ? [roomPts.reduce((s, p) => s + p[0], 0) / roomPts.length, roomPts.reduce((s, p) => s + p[1], 0) / roomPts.length]
    : [cx, cy];

  const cands: ExitCand[] = [];
  for (const door of floor.doors) {
    if (!door.exit) continue;
    const wall = floor.walls.find((w) => w.id === door.wallId);
    if (!wall) continue;
    const at: Point = [
      wall.a[0] + (wall.b[0] - wall.a[0]) * door.t,
      wall.a[1] + (wall.b[1] - wall.a[1]) * door.t,
    ];
    const dx = wall.b[0] - wall.a[0];
    const dy = wall.b[1] - wall.a[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    // Force outward (away from interior midpoint).
    if ((mid[0] - at[0]) * nx + (mid[1] - at[1]) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    cands.push({
      at,
      outside: [at[0] + nx * 1.5, at[1] + ny * 1.5],
      named: /front/i.test(door.id),
      streetDot: street ? nx * street[0] + ny * street[1] : 0,
      atY: at[1],
    });
  }
  if (!cands.length) return null;

  cands.sort((a, b) => {
    if (a.named !== b.named) return a.named ? -1 : 1;
    if (street && Math.abs(a.streetDot - b.streetDot) > 0.05) return b.streetDot - a.streetDot;
    return a.atY - b.atY;
  });
  return cands[0]!.outside;
}

function collectRoadPolylines(features: CompoundFeature[]): Point[][] {
  const lines: Point[][] = [];
  for (const f of features) {
    if (f.kind !== "road" && f.kind !== "driveway") continue;
    const cl = featureCenterline(f.polygon);
    if (cl.length >= 2) lines.push(cl);
    else if (cl.length === 1) lines.push([cl[0]!, cl[0]!]);
  }
  return lines;
}

type Snap = { pt: Point; lineIdx: number; segIdx: number; t: number; d: number };

function closestOnRoads(p: Point, lines: Point[][]): Snap | null {
  let best: Snap | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    for (let i = 0; i < line.length - 1; i++) {
      const hit = closestOnSeg(p, line[i]!, line[i + 1]!);
      if (!best || hit.d < best.d) {
        best = { pt: hit.pt, lineIdx: li, segIdx: i, t: hit.t, d: hit.d };
      }
    }
  }
  return best;
}

/** Graph walk along road centerlines from snapA → snapB (Dijkstra on vertices + snaps). */
function walkRoads(snapA: Snap, snapB: Snap, lines: Point[][]): Point[] {
  type Node = { key: string; pos: Point };
  const nodes: Node[] = [];
  const keyOf = (lineIdx: number, vi: number) => `v:${lineIdx}:${vi}`;
  const adj = new Map<string, Array<{ to: string; w: number }>>();

  const link = (a: string, b: string, w: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, w });
    adj.get(b)!.push({ to: a, w });
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    for (let i = 0; i < line.length; i++) {
      const key = keyOf(li, i);
      nodes.push({ key, pos: line[i]! });
      if (i > 0) link(keyOf(li, i - 1), key, dist(line[i - 1]!, line[i]!));
    }
  }

  // Join nearby endpoints across different polylines.
  const ends: Array<{ key: string; pos: Point }> = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    ends.push({ key: keyOf(li, 0), pos: line[0]! });
    ends.push({ key: keyOf(li, line.length - 1), pos: line[line.length - 1]! });
  }
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const d = dist(ends[i]!.pos, ends[j]!.pos);
      if (d > 0.05 && d <= ROAD_JOIN_M) link(ends[i]!.key, ends[j]!.key, d);
    }
  }

  const startKey = "snap:A";
  const endKey = "snap:B";
  nodes.push({ key: startKey, pos: snapA.pt });
  nodes.push({ key: endKey, pos: snapB.pt });

  const attachSnap = (snap: Snap, key: string) => {
    const line = lines[snap.lineIdx]!;
    const aKey = keyOf(snap.lineIdx, snap.segIdx);
    const bKey = keyOf(snap.lineIdx, snap.segIdx + 1);
    link(key, aKey, dist(snap.pt, line[snap.segIdx]!));
    link(key, bKey, dist(snap.pt, line[snap.segIdx + 1]!));
  };
  attachSnap(snapA, startKey);
  attachSnap(snapB, endKey);

  // Same-segment shortcut.
  if (snapA.lineIdx === snapB.lineIdx && snapA.segIdx === snapB.segIdx) {
    link(startKey, endKey, dist(snapA.pt, snapB.pt));
  }

  const distMap = new Map<string, number>();
  const prev = new Map<string, string>();
  const pq: Array<{ key: string; d: number }> = [{ key: startKey, d: 0 }];
  distMap.set(startKey, 0);

  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const cur = pq.shift()!;
    if (cur.d !== distMap.get(cur.key)) continue;
    if (cur.key === endKey) break;
    for (const e of adj.get(cur.key) ?? []) {
      const nd = cur.d + e.w;
      if (nd < (distMap.get(e.to) ?? Infinity)) {
        distMap.set(e.to, nd);
        prev.set(e.to, cur.key);
        pq.push({ key: e.to, d: nd });
      }
    }
  }

  if (!distMap.has(endKey)) {
    // Disconnected: jump straight between snaps.
    return [snapA.pt, snapB.pt];
  }

  const posByKey = new Map(nodes.map((n) => [n.key, n.pos]));
  const chain: Point[] = [];
  let k: string | undefined = endKey;
  while (k) {
    const p = posByKey.get(k);
    if (p) chain.push(p);
    k = prev.get(k);
  }
  chain.reverse();
  return chain;
}

function buildLayPath(hydrant: Point, entry: Point, roads: Point[][]): Point[] {
  if (!roads.length) return [hydrant, entry];
  const snapH = closestOnRoads(hydrant, roads);
  const snapE = closestOnRoads(entry, roads);
  if (!snapH || !snapE) return [hydrant, entry];
  const along = walkRoads(snapH, snapE, roads);
  return dedupePath([hydrant, ...along, entry]);
}

/**
 * Plan hydrant → Alpha entry hose lays, shortest first.
 * Returns up to `maxHydrants` (default 3). Empty when no hydrants or no entry.
 */
export function planHoseLays(model: BuildingModel, opts?: { maxHydrants?: number }): HoseLay[] {
  const maxN = opts?.maxHydrants ?? DEFAULT_MAX;
  const hydrants = collectHydrants(model);
  if (!hydrants.length) return [];

  const entryPos = findAlphaEntry(model);
  if (!entryPos) return [];

  const roads = collectRoadPolylines(model.compound?.features ?? []);

  const lays: HoseLay[] = hydrants.map((h) => {
    const path = buildLayPath(h.pos, entryPos, roads);
    const lengthM = pathLength(path);
    return {
      hydrantId: h.id,
      hydrantPos: [h.pos[0], h.pos[1]],
      entryPos: [entryPos[0], entryPos[1]],
      path: path.map((p) => [p[0], p[1]] as [number, number]),
      lengthM,
      lengthFt: lengthM * M_TO_FT,
      loadHint: loadHintFor(lengthM),
      rank: 0,
    };
  });

  lays.sort((a, b) => a.lengthM - b.lengthM || a.hydrantId.localeCompare(b.hydrantId));
  return lays.slice(0, Math.max(0, maxN)).map((lay, i) => ({ ...lay, rank: i }));
}
