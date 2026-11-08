/**
 * Wall-aware walking for the tracked firefighter.
 *
 * The scanner only gives a rough x/y, so the raw position can land inside a wall or on the far side of one.
 * The drawn firefighter therefore walks toward each fix like a real person: in a straight line when the way
 * is clear, otherwise along a path that goes through door openings and around the building.
 */
import type { Floor, Point } from "../packages/schema/building-model.ts";
import { MinHeap, blockedByWall, pointInRing } from "./route";

export type WalkGrid = {
  floor: Floor;
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  cell: number;
  /** 1 = a person can stand here (outdoors, or inside a room). */
  ok: Uint8Array;
  /** 1 = close enough to a wall that edges here need the exact wall test. */
  near: Uint8Array;
  /** false when the floor has no known rooms: then nothing blocks movement. */
  constrained: boolean;
};

export function buildWalkGrid(floor: Floor, footprint: Point[], margin = 30, cell = 0.3): WalkGrid {
  const xs = footprint.map((p) => p[0]);
  const ys = footprint.map((p) => p[1]);
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const nx = Math.ceil((Math.max(...xs) + margin - minX) / cell) + 1;
  const ny = Math.ceil((Math.max(...ys) + margin - minY) / cell) + 1;
  const constrained = floor.rooms.length > 0 && footprint.length >= 3;
  const ok = new Uint8Array(nx * ny).fill(1);
  const near = new Uint8Array(nx * ny);
  const g: WalkGrid = { floor, minX, minY, nx, ny, cell, ok, near, constrained };
  if (!constrained) return g;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p: Point = [minX + (i + 0.5) * cell, minY + (j + 0.5) * cell];
      if (!pointInRing(p, footprint)) continue; // outdoors: free
      ok[j * nx + i] = floor.rooms.some((r) => pointInRing(p, r.polygon)) ? 1 : 0;
    }
  }
  for (const w of floor.walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const steps = Math.max(1, Math.ceil(len / (cell / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const [ci, cj] = cellAt(g, [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t]);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i >= 0 && j >= 0 && i < nx && j < ny) near[j * nx + i] = 1;
        }
      }
    }
  }
  return g;
}

export const cellAt = (g: WalkGrid, p: Point): [number, number] => [
  Math.floor((p[0] - g.minX) / g.cell),
  Math.floor((p[1] - g.minY) / g.cell),
];
const center = (g: WalkGrid, i: number, j: number): Point => [g.minX + (i + 0.5) * g.cell, g.minY + (j + 0.5) * g.cell];

export function isWalkable(g: WalkGrid, p: Point): boolean {
  if (!g.constrained) return true;
  const [i, j] = cellAt(g, p);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return true; // beyond the grid is open ground
  return g.ok[j * g.nx + i] === 1;
}

/** Can you walk straight a -> b: no wall in the way (doors are gaps) and every step on walkable ground? */
export function lineClear(g: WalkGrid, a: Point, b: Point): boolean {
  if (!g.constrained) return true;
  if (blockedByWall(g.floor, a, b)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.12));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!isWalkable(g, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
  }
  return true;
}

function nearestWalkable(g: WalkGrid, p: Point, maxR = 4): [number, number] | null {
  const [ci, cj] = cellAt(g, p);
  const R = Math.ceil(maxR / g.cell);
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny || !g.ok[j * g.nx + i]) continue;
      const d = Math.hypot(di, dj);
      if (d < bestD) {
        bestD = d;
        best = [i, j];
      }
    }
  }
  return best;
}

const DIRS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** A* from a to b through doors and around the building. Null when there is no way. */
export function planPath(g: WalkGrid, a: Point, b: Point): Point[] | null {
  if (!g.constrained) return [b];
  const s = nearestWalkable(g, a);
  const t = nearestWalkable(g, b);
  if (!s || !t) return null;
  const N = g.nx * g.ny;
  const start = s[1] * g.nx + s[0];
  const goal = t[1] * g.nx + t[0];
  const cost = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  cost[start] = 0;
  heap.push(0, start);
  const gi = t[0];
  const gj = t[1];
  let found = false;
  while (heap.size) {
    const [, u] = heap.pop();
    if (u === goal) {
      found = true;
      break;
    }
    const ci = u % g.nx;
    const cj = (u - ci) / g.nx;
    const cu = center(g, ci, cj);
    for (const [di, dj] of DIRS) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const v = j * g.nx + i;
      if (!g.ok[v]) continue;
      if (di !== 0 && dj !== 0 && (!g.ok[cj * g.nx + i] || !g.ok[j * g.nx + ci])) continue;
      if ((g.near[u] || g.near[v]) && blockedByWall(g.floor, cu, center(g, i, j))) continue;
      const nd = cost[u] + Math.hypot(di, dj) * g.cell * (g.near[v] ? 1.4 : 1);
      if (nd < cost[v]) {
        cost[v] = nd;
        prev[v] = u;
        heap.push(nd + Math.hypot(i - gi, j - gj) * g.cell, v);
      }
    }
  }
  if (!found) return null;

  const cells: Point[] = [];
  for (let n = goal; n !== -1; n = prev[n]) {
    const i = n % g.nx;
    cells.push(center(g, i, (n - i) / g.nx));
  }
  cells.reverse();
  // String-pull: keep only the corners you actually need.
  const out: Point[] = [];
  let from: Point = a;
  let k = 0;
  while (k < cells.length) {
    let far = k;
    for (let m = cells.length - 1; m > k; m--) {
      if (lineClear(g, from, cells[m])) {
        far = m;
        break;
      }
    }
    out.push(cells[far]);
    from = cells[far];
    k = far + 1;
  }
  if (lineClear(g, out.length > 1 ? out[out.length - 2] : a, b)) out[out.length - 1] = b;
  return out;
}

/** A walker that chases a noisy target without ever crossing a wall. */
export class WalkMover {
  pos: Point;
  private queue: Point[] = [];
  private planned: Point | null = null;
  private retry = 0;

  constructor(start: Point) {
    this.pos = [start[0], start[1]];
  }

  /** Advance by dt seconds toward `target`. Returns the heading in radians (atan2(dx, dy)) if it moved. */
  step(g: WalkGrid, target: Point, dt: number, speed = 2.6): { moved: boolean; dx: number; dy: number } {
    this.retry -= dt;
    const targetMoved = !this.planned || Math.hypot(this.planned[0] - target[0], this.planned[1] - target[1]) > 0.4;
    if (targetMoved || (this.queue.length === 0 && this.retry <= 0 && Math.hypot(this.pos[0] - target[0], this.pos[1] - target[1]) > 0.3)) {
      this.planned = target;
      if (lineClear(g, this.pos, target)) {
        this.queue = [target];
      } else {
        const path = planPath(g, this.pos, target);
        this.queue = path ?? [];
        // No way through (e.g. target sealed off): wait a moment before trying again.
        this.retry = path ? 0 : 1;
      }
    }
    let remaining = speed * dt;
    let mx = 0;
    let my = 0;
    while (remaining > 1e-6 && this.queue.length) {
      const w = this.queue[0];
      const dx = w[0] - this.pos[0];
      const dy = w[1] - this.pos[1];
      const d = Math.hypot(dx, dy);
      if (d <= remaining) {
        this.pos = [w[0], w[1]];
        this.queue.shift();
        remaining -= d;
        mx += dx;
        my += dy;
      } else {
        this.pos = [this.pos[0] + (dx / d) * remaining, this.pos[1] + (dy / d) * remaining];
        mx += (dx / d) * remaining;
        my += (dy / d) * remaining;
        remaining = 0;
      }
    }
    return { moved: Math.hypot(mx, my) > 1e-6, dx: mx, dy: my };
  }
}
