/**
 * Ventilation / vertical-path graph: stair shafts (and optional atrium/lobby
 * voids) as continuous smoke-travel columns through a multi-level building.
 *
 * Independent of the walking router in route.ts, but uses the same idea:
 * match footprints across adjacent floors when they overlap or sit within ~2 m.
 */
import type { BuildingModel, Floor, Point, Room } from "../packages/schema/building-model";
import { dist, distToRing, pointInPolygon, polygonCentroid } from "./geo";

export type VentNode = {
  level: number;
  roomId?: string;
  center: [number, number];
  kind: "stair" | "atrium" | "shaft";
};

export type VentEdge = {
  /** Index into VentGraph.nodes */
  from: number;
  /** Index into VentGraph.nodes */
  to: number;
  via: string;
};

export type VentGraph = {
  nodes: VentNode[];
  edges: VentEdge[];
  stacks: Array<{
    id: string;
    levels: number[];
    centers: [number, number][];
    kind: VentNode["kind"];
  }>;
};

const LINK_DIST_M = 2;

type Candidate = {
  level: number;
  roomId?: string;
  center: [number, number];
  polygon: Point[];
  kind: VentNode["kind"];
  sourceId: string;
};

function centroid(poly: Point[]): [number, number] {
  const c = polygonCentroid(poly);
  return [c[0], c[1]];
}

/** True when footprints overlap or their centers are within ~2 m horizontally. */
function footprintsLink(a: Point[], ca: Point, b: Point[], cb: Point, maxDist = LINK_DIST_M): boolean {
  if (pointInPolygon(ca, b) || pointInPolygon(cb, a)) return true;
  if (dist(ca, cb) <= maxDist) return true;
  if (distToRing(ca, b) <= maxDist || distToRing(cb, a) <= maxDist) return true;
  return false;
}

function voidKindFromRoom(room: Room): VentNode["kind"] | null {
  const label = `${room.name} ${room.id}`.toLowerCase();
  if (/\bshaft\b/.test(label)) return "shaft";
  if (/\batrium\b/.test(label)) return "atrium";
  if (/\blobby\b/.test(label)) return "atrium";
  return null;
}

function collectCandidates(floor: Floor): Candidate[] {
  const out: Candidate[] = [];

  for (const room of floor.rooms) {
    if (room.type === "stair") {
      const c = centroid(room.polygon);
      out.push({
        level: floor.level,
        roomId: room.id,
        center: c,
        polygon: room.polygon,
        kind: "stair",
        sourceId: room.id,
      });
      continue;
    }
    const voidKind = voidKindFromRoom(room);
    if (voidKind) {
      const c = centroid(room.polygon);
      out.push({
        level: floor.level,
        roomId: room.id,
        center: c,
        polygon: room.polygon,
        kind: voidKind,
        sourceId: room.id,
      });
    }
  }

  for (const stair of floor.stairs) {
    const c = centroid(stair.polygon);
    // Skip stair footprints already represented by a stair room on this floor.
    const already = out.some(
      (o) =>
        o.kind === "stair" &&
        (dist(o.center, c) <= LINK_DIST_M ||
          pointInPolygon(c, o.polygon) ||
          pointInPolygon(o.center, stair.polygon)),
    );
    if (already) continue;
    out.push({
      level: floor.level,
      roomId: undefined,
      center: c,
      polygon: stair.polygon,
      kind: "stair",
      sourceId: stair.id,
    });
  }

  return out;
}

function compatibleKinds(a: VentNode["kind"], b: VentNode["kind"]): boolean {
  if (a === b) return true;
  // Treat atrium and shaft as interchangeable vertical voids.
  return (a === "atrium" || a === "shaft") && (b === "atrium" || b === "shaft");
}

function kindPriority(k: VentNode["kind"]): number {
  if (k === "stair") return 3;
  if (k === "shaft") return 2;
  return 1;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let p = i;
    while (this.parent[p] !== p) p = this.parent[p];
    let x = i;
    while (this.parent[x] !== p) {
      const n = this.parent[x];
      this.parent[x] = p;
      x = n;
    }
    return p;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export function buildVentGraph(model: BuildingModel): VentGraph {
  const floors = [...model.floors].sort((a, b) => a.level - b.level);
  const levels = floors.map((f) => f.level);

  const candidates: Candidate[] = [];
  for (const floor of floors) {
    candidates.push(...collectCandidates(floor));
  }

  const nodes: VentNode[] = candidates.map((c) => ({
    level: c.level,
    roomId: c.roomId,
    center: c.center,
    kind: c.kind,
  }));

  const edges: VentEdge[] = [];
  const uf = new UnionFind(nodes.length);

  for (let li = 0; li + 1 < levels.length; li++) {
    const loLevel = levels[li];
    const hiLevel = levels[li + 1];
    const loIdx: number[] = [];
    const hiIdx: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].level === loLevel) loIdx.push(i);
      if (candidates[i].level === hiLevel) hiIdx.push(i);
    }

    const usedHi = new Set<number>();
    for (const i of loIdx) {
      const lo = candidates[i];
      let best: { j: number; d: number } | null = null;
      for (const j of hiIdx) {
        if (usedHi.has(j)) continue;
        const hi = candidates[j];
        if (!compatibleKinds(lo.kind, hi.kind)) continue;
        if (!footprintsLink(lo.polygon, lo.center, hi.polygon, hi.center)) continue;
        const d = dist(lo.center, hi.center);
        if (!best || d < best.d) best = { j, d };
      }
      if (!best) continue;
      const j = best.j;
      usedHi.add(j);
      const via = `${candidates[i].sourceId}->${candidates[j].sourceId}`;
      edges.push({ from: i, to: j, via });
      uf.union(i, j);
    }
  }

  // Group connected components into vertical stacks (continuous columns).
  const groups = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  const stacks: VentGraph["stacks"] = [];
  let stairN = 0;
  let atriumN = 0;
  let shaftN = 0;

  for (const idxs of groups.values()) {
    // A stack needs at least two levels (a vertical column).
    const byLevel = new Map<number, number[]>();
    for (const i of idxs) {
      const lv = nodes[i].level;
      const list = byLevel.get(lv) ?? [];
      list.push(i);
      byLevel.set(lv, list);
    }
    if (byLevel.size < 2) continue;

    const stackLevels = [...byLevel.keys()].sort((a, b) => a - b);
    // Prefer contiguous runs of adjacent building levels.
    const levelSet = new Set(levels);
    const runs: number[][] = [];
    let run: number[] = [stackLevels[0]];
    for (let k = 1; k < stackLevels.length; k++) {
      const prev = stackLevels[k - 1];
      const cur = stackLevels[k];
      const prevPos = levels.indexOf(prev);
      const nextExpected = prevPos >= 0 ? levels[prevPos + 1] : null;
      if (nextExpected === cur || (levelSet.has(cur) && cur === prev + 1)) {
        run.push(cur);
      } else {
        if (run.length >= 2) runs.push(run);
        run = [cur];
      }
    }
    if (run.length >= 2) runs.push(run);

    for (const runLevels of runs.length ? runs : stackLevels.length >= 2 ? [stackLevels] : []) {
      const centers: [number, number][] = runLevels.map((lv) => {
        const members = byLevel.get(lv)!;
        const sx = members.reduce((s, i) => s + nodes[i].center[0], 0);
        const sy = members.reduce((s, i) => s + nodes[i].center[1], 0);
        return [sx / members.length, sy / members.length];
      });
      const kinds = runLevels.flatMap((lv) => byLevel.get(lv)!.map((i) => nodes[i].kind));
      const kind = kinds.reduce((best, k) => (kindPriority(k) > kindPriority(best) ? k : best), kinds[0]);
      let id: string;
      if (kind === "stair") id = `stair-${stairN++}`;
      else if (kind === "shaft") id = `shaft-${shaftN++}`;
      else id = `atrium-${atriumN++}`;
      stacks.push({ id, levels: runLevels, centers, kind });
    }
  }

  stacks.sort((a, b) => a.levels[0] - b.levels[0] || a.id.localeCompare(b.id));

  return { nodes, edges, stacks };
}

/** Stacks that touch the fire floor (smoke can enter and typically travel upward). */
export function smokeLikelyStacks(graph: VentGraph, fireFloor: number): VentGraph["stacks"] {
  return graph.stacks.filter((s) => s.levels.includes(fireFloor));
}
