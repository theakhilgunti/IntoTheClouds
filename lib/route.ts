/**
 * Walking-route planner: front door -> marker, on any floor.
 *
 * Builds a walkable grid per floor from the room polygons, blocks movement
 * through walls except at door openings, links floors through matching stair
 * rooms, then runs Dijkstra and straightens the result.
 *
 * Stairs: the schema only gives a stair footprint, not which end is the bottom.
 * We take the two ends of the footprint's long axis and allow either end to be
 * the bottom (`assumedStairs` is set on any route that climbs).
 */
import type { BuildingModel, Floor, Marker, Point } from "../packages/schema/building-model.ts";

const CELL = 0.2;
const STAIR_END_INSET = 0.2;

export type RouteNode = { level: number; pt: Point };
export type Route = {
  doorId: string;
  nodes: RouteNode[];
  length: number;
  /** True when the route uses stairs whose up/down end had to be assumed. */
  assumedStairs: boolean;
  /** True when the building has no known interior here, so this is a straight-line guess, not a walkable path. */
  estimated?: boolean;
};

type FloorGrid = {
  floor: Floor;
  walkable: Uint8Array;
  penalty: Float32Array;
};

export type Nav = {
  model: BuildingModel;
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  grids: Map<number, FloorGrid>;
  /** Directed edges between cells of different floors: key = global node id. */
  links: Map<number, Array<{ to: number; cost: number }>>;
  levels: number[];
  frontDoor: { doorId: string; level: number; at: Point; inside: Point } | null;
};

function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** If segment p->p2 crosses q->q2, return how far along q (0..1) it crosses. */
function hitAlong(p: Point, p2: Point, q: Point, q2: Point): number | null {
  const rx = p2[0] - p[0];
  const ry = p2[1] - p[1];
  const sx = q2[0] - q[0];
  const sy = q2[1] - q[1];
  const denom = cross(rx, ry, sx, sy);
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = q[0] - p[0];
  const qpy = q[1] - p[1];
  const t = cross(qpx, qpy, sx, sy) / denom;
  const u = cross(qpx, qpy, rx, ry) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : null;
}

/** True when walking a->b on this floor would pass through a wall that has no door there. */
function blockedByWall(floor: Floor, a: Point, b: Point): boolean {
  for (const w of floor.walls) {
    const u = hitAlong(a, b, w.a, w.b);
    if (u === null) continue;
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const at = u * len;
    const open = floor.doors.some(
      (d) => d.wallId === w.id && Math.abs(d.t * len - at) <= d.width / 2 + 0.05,
    );
    if (!open) return true;
  }
  return false;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function buildNav(model: BuildingModel): Nav {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (p: Point) => { xs.push(p[0]); ys.push(p[1]); };
  model.footprint.forEach(add);
  for (const f of model.floors) {
    f.rooms.forEach((r) => r.polygon.forEach(add));
    f.walls.forEach((w) => { add(w.a); add(w.b); });
  }
  const minX = Math.min(...xs) - 1;
  const minY = Math.min(...ys) - 1;
  const nx = Math.ceil((Math.max(...xs) + 1 - minX) / CELL) + 1;
  const ny = Math.ceil((Math.max(...ys) + 1 - minY) / CELL) + 1;
  const N = nx * ny;
  const levels = model.floors.map((f) => f.level).sort((a, b) => a - b);
  const nav: Nav = { model, minX, minY, nx, ny, grids: new Map(), links: new Map(), levels, frontDoor: null };

  for (const floor of model.floors) {
    const walkable = new Uint8Array(N);
    const penalty = new Float32Array(N);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = cellCenter(nav, i, j);
        if (!floor.rooms.some((r) => pointInRing(p, r.polygon))) continue;
        const c = j * nx + i;
        walkable[c] = 1;
        let d = Infinity;
        for (const w of floor.walls) d = Math.min(d, distToSegment(p, w.a, w.b));
        // Stay off walls where possible so the line runs down the middle of halls.
        penalty[c] = d < 0.4 ? ((0.4 - d) / 0.4) * 1.5 : 0;
      }
    }
    nav.grids.set(floor.level, { floor, walkable, penalty });
  }

  linkStairs(nav);
  nav.frontDoor = findFrontDoor(nav);
  return nav;
}

const cellCenter = (nav: Nav, i: number, j: number): Point => [nav.minX + (i + 0.5) * CELL, nav.minY + (j + 0.5) * CELL];
const cellOf = (nav: Nav, p: Point): [number, number] => [
  Math.floor((p[0] - nav.minX) / CELL),
  Math.floor((p[1] - nav.minY) / CELL),
];
const nodeId = (nav: Nav, levelIdx: number, c: number) => levelIdx * nav.nx * nav.ny + c;

/** Nearest walkable cell on a floor within `maxR` meters, or null. */
function snap(nav: Nav, level: number, p: Point, maxR = 2): number | null {
  const g = nav.grids.get(level);
  if (!g) return null;
  const [ci, cj] = cellOf(nav, p);
  const R = Math.ceil(maxR / CELL);
  let best: number | null = null;
  let bestD = Infinity;
  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= nav.nx || j >= nav.ny) continue;
      const c = j * nav.nx + i;
      if (!g.walkable[c]) continue;
      const d = Math.hypot(di, dj);
      if (d < bestD) { bestD = d; best = c; }
    }
  }
  return best;
}

/** Connect each pair of vertically adjacent floors through overlapping stair rooms. */
function linkStairs(nav: Nav) {
  const addLink = (a: number, b: number, cost: number) => {
    for (const [from, to] of [[a, b], [b, a]]) {
      const list = nav.links.get(from) ?? [];
      list.push({ to, cost });
      nav.links.set(from, list);
    }
  };
  for (let li = 0; li + 1 < nav.levels.length; li++) {
    const lo = nav.grids.get(nav.levels[li])!.floor;
    const hi = nav.grids.get(nav.levels[li + 1])!.floor;
    const climb = Math.max(0.5, hi.elevation - lo.elevation);
    for (const loRoom of lo.rooms.filter((r) => r.type === "stair")) {
      const c = centroid(loRoom.polygon);
      const hiRoom = hi.rooms.find((r) => r.type === "stair" && (pointInRing(c, r.polygon) || pointInRing(centroid(r.polygon), loRoom.polygon)));
      if (!hiRoom) continue;
      const { ends, run } = stairEnds(loRoom.polygon);
      const [e0, e1] = ends;
      const lo0 = snap(nav, lo.level, e0, 0.8);
      const lo1 = snap(nav, lo.level, e1, 0.8);
      const hi0 = snap(nav, hi.level, e0, 0.8);
      const hi1 = snap(nav, hi.level, e1, 0.8);
      if (lo0 === null || lo1 === null || hi0 === null || hi1 === null) continue;
      const cost = Math.hypot(run, climb);
      addLink(nodeId(nav, li, lo0), nodeId(nav, li + 1, hi1), cost);
      addLink(nodeId(nav, li, lo1), nodeId(nav, li + 1, hi0), cost);
    }
  }
}

function centroid(poly: Point[]): Point {
  return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
}

/** The two ends of a stair footprint along its long axis (principal component). */
export function stairEnds(poly: Point[]): { ends: [Point, Point]; run: number; width: number } {
  const [cx, cy] = centroid(poly);
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of poly) {
    sxx += (x - cx) ** 2;
    sxy += (x - cx) * (y - cy);
    syy += (y - cy) ** 2;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [x, y] of poly) {
    const a = (x - cx) * ux + (y - cy) * uy;
    const b = -(x - cx) * uy + (y - cy) * ux;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  // Square-ish footprints have no meaningful long axis, but the pair of ends is still valid.
  const lo = minA + STAIR_END_INSET;
  const hi = maxA - STAIR_END_INSET;
  return {
    ends: [[cx + ux * lo, cy + uy * lo], [cx + ux * hi, cy + uy * hi]],
    run: maxA - minA,
    width: maxB - minB,
  };
}

function findFrontDoor(nav: Nav): Nav["frontDoor"] {
  // Ground-level (or lowest non-basement) floor that has an exterior door.
  const candidates = nav.model.floors
    .filter((f) => f.level >= 0 && f.doors.some((d) => d.exit))
    .sort((a, b) => a.level - b.level);
  const floor = candidates[0] ?? nav.model.floors.find((f) => f.doors.some((d) => d.exit));
  if (!floor) return null;
  const exits = floor.doors.filter((d) => d.exit);
  const pos = (d: (typeof exits)[number]) => {
    const w = floor.walls.find((w) => w.id === d.wallId)!;
    return { w, at: [w.a[0] + (w.b[0] - w.a[0]) * d.t, w.a[1] + (w.b[1] - w.a[1]) * d.t] as Point };
  };
  const withWall = exits.filter((d) => floor.walls.some((w) => w.id === d.wallId));
  if (!withWall.length) return null;
  // Prefer a door named "front"; otherwise the southernmost (templates put the front at -y).
  const door =
    withWall.find((d) => /front/i.test(d.id)) ??
    [...withWall].sort((a, b) => pos(a).at[1] - pos(b).at[1])[0];
  const { w, at } = pos(door);
  // Step inside: along the wall normal, toward the middle of the floor's rooms.
  const mid = centroid(floor.rooms.flatMap((r) => r.polygon));
  const dx = w.b[0] - w.a[0];
  const dy = w.b[1] - w.a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nxv = -dy / len;
  let nyv = dx / len;
  if ((mid[0] - at[0]) * nxv + (mid[1] - at[1]) * nyv < 0) { nxv = -nxv; nyv = -nyv; }
  return { doorId: door.id, level: floor.level, at, inside: [at[0] + nxv * 0.6, at[1] + nyv * 0.6] };
}

class MinHeap {
  private a: Array<[number, number]> = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Route from the front door to a marker, or null when no walkable way exists. */
export function routeToMarker(nav: Nav, marker: Pick<Marker, "floor" | "pos">): Route | null {
  const door = nav.frontDoor;
  const known = (level: number) => (nav.grids.get(level)?.floor.rooms.length ?? 0) > 0;
  const groundLevel = nav.levels.find((l) => l >= 0) ?? nav.levels[0];
  // No rooms/doors on file (typical for scanned houses): draw an honest straight-line estimate.
  if (!door || !known(door.level) || !known(marker.floor)) return estimatedRoute(nav.model, marker, groundLevel);
  const startLi = nav.levels.indexOf(door.level);
  const goalLi = nav.levels.indexOf(marker.floor);
  if (startLi < 0 || goalLi < 0) return null;
  const startCell = snap(nav, door.level, door.inside, 1.5);
  const goalCell = snap(nav, marker.floor, marker.pos, 1.5);
  if (startCell === null || goalCell === null) return null;

  const N = nav.nx * nav.ny;
  const start = nodeId(nav, startLi, startCell);
  const goal = nodeId(nav, goalLi, goalCell);
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const heap = new MinHeap();
  heap.push(0, start);

  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === goal) break;
    const li = Math.floor(u / N);
    const c = u % N;
    const g = nav.grids.get(nav.levels[li])!;
    const ci = c % nav.nx;
    const cj = Math.floor(c / nav.nx);
    const relax = (v: number, cost: number) => {
      const nd = d + cost;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); heap.push(nd, v); }
    };
    for (const [di, dj] of DIRS) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= nav.nx || j >= nav.ny) continue;
      const v = j * nav.nx + i;
      if (!g.walkable[v]) continue;
      if (di !== 0 && dj !== 0 && (!g.walkable[cj * nav.nx + i] || !g.walkable[j * nav.nx + ci])) continue;
      if (blockedByWall(g.floor, cellCenter(nav, ci, cj), cellCenter(nav, i, j))) continue;
      relax(nodeId(nav, li, v), Math.hypot(di, dj) * CELL * (1 + g.penalty[v]));
    }
    for (const l of nav.links.get(u) ?? []) relax(l.to, l.cost);
  }
  if (!dist.has(goal)) return null;

  // Rebuild the cell path, then straighten each same-floor stretch.
  const ids: number[] = [];
  for (let n: number | undefined = goal; n !== undefined; n = prev.get(n)) ids.push(n);
  ids.reverse();
  let nodes: RouteNode[] = ids.map((id) => {
    const li = Math.floor(id / N);
    const c = id % N;
    return { level: nav.levels[li], pt: cellCenter(nav, c % nav.nx, Math.floor(c / nav.nx)) };
  });
  nodes = straighten(nav, nodes);
  const assumedStairs = nodes.some((n, i) => i > 0 && nodes[i - 1].level !== n.level);
  nodes = [{ level: door.level, pt: door.at }, ...nodes, { level: marker.floor, pt: marker.pos }];

  let length = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].level === nodes[i - 1].level) {
      length += Math.hypot(nodes[i].pt[0] - nodes[i - 1].pt[0], nodes[i].pt[1] - nodes[i - 1].pt[1]);
    }
  }
  return { doorId: door.doorId, nodes, length, assumedStairs };
}

/** Can you walk straight a->b on this floor (every sample walkable, no wall in the way)? */
function clearLine(nav: Nav, level: number, a: Point, b: Point): boolean {
  const g = nav.grids.get(level)!;
  if (blockedByWall(g.floor, a, b)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const [i, j] = cellOf(nav, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (i < 0 || j < 0 || i >= nav.nx || j >= nav.ny || !g.walkable[j * nav.nx + i]) return false;
  }
  return true;
}

function straighten(nav: Nav, nodes: RouteNode[]): RouteNode[] {
  const out: RouteNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    // Extent of this floor's stretch.
    let end = i;
    while (end + 1 < nodes.length && nodes[end + 1].level === nodes[i].level) end++;
    let k = i;
    out.push(nodes[k]);
    while (k < end) {
      let far = end;
      while (far > k + 1 && !clearLine(nav, nodes[k].level, nodes[k].pt, nodes[far].pt)) far--;
      out.push(nodes[far]);
      k = far;
    }
    i = end + 1;
  }
  return out;
}

/**
 * Fallback when the interior is unknown: from the street-side wall (southernmost footprint edge,
 * where templates put the front) straight to the marker, then up/down to its floor.
 */
function estimatedRoute(model: BuildingModel, marker: Pick<Marker, "floor" | "pos">, groundLevel: number): Route | null {
  const fp = model.footprint;
  if (fp.length < 3 || groundLevel === undefined) return null;
  let best: { mid: Point; edge: [Point, Point] } | null = null;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const b = fp[(i + 1) % fp.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) continue;
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!best || mid[1] < best.mid[1]) best = { mid, edge: [a, b] };
  }
  if (!best) return null;
  const nodes: RouteNode[] = [{ level: groundLevel, pt: best.mid }];
  if (marker.floor !== groundLevel) nodes.push({ level: groundLevel, pt: marker.pos });
  nodes.push({ level: marker.floor, pt: marker.pos });
  const length = Math.hypot(marker.pos[0] - best.mid[0], marker.pos[1] - best.mid[1]);
  return { doorId: "estimated-front", nodes, length, assumedStairs: marker.floor !== groundLevel, estimated: true };
}
