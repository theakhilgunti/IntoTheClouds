/** Lot, outbuilding, and aerial-box geometry. No app imports, so node:test can load it. */
export type Point = [number, number];

export type CompoundKind = "yard" | "garage" | "shed" | "driveway" | "patio" | "pool" | "fence" | "trees" | "road";

export type SiteFeature = {
  id: string;
  kind: CompoundKind;
  label: string;
  polygon: Point[];
  height: number;
  source: "map" | "aerial" | "parcel";
};

const OUTBUILDING: Record<string, "garage" | "shed"> = {
  garage: "garage",
  garages: "garage",
  carport: "garage",
  roof: "garage",
  shed: "shed",
  hut: "shed",
  cabin: "shed",
  barn: "shed",
  greenhouse: "shed",
};

const HEIGHT: Record<CompoundKind, number> = {
  yard: 0.04,
  garage: 2.6,
  shed: 2.2,
  driveway: 0.08,
  patio: 0.14,
  pool: 0.2,
  fence: 1.05,
  trees: 4,
  road: 0.06,
};

const LABEL: Record<CompoundKind, string> = {
  yard: "Lot",
  garage: "Garage",
  shed: "Shed",
  driveway: "Driveway",
  patio: "Patio",
  pool: "Pool",
  fence: "Fence",
  trees: "Trees",
  road: "Street",
};

function dist(a: Point, b: Point) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function ringCentroid(ring: Point[]): Point {
  const n = ring.length || 1;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

export function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(p: Point, ring: Point[]): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, dist(p, [a[0] + t * dx, a[1] + t * dy]));
  }
  return best;
}

/** Image box in 0..1000 (x right / east, y down / south) onto meters around the image center. */
export function boxToPolygon(
  box: { x0: number; y0: number; x1: number; y1: number },
  halfSize: number,
): Point[] | null {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  if ((x1 - x0) * (y1 - y0) > 350_000) return null;
  const toM = (nx: number, ny: number): Point => [
    (nx / 1000 - 0.5) * 2 * halfSize,
    (0.5 - ny / 1000) * 2 * halfSize,
  ];
  const poly: Point[] = [toM(x0, y0), toM(x1, y0), toM(x1, y1), toM(x0, y1)];
  const w = dist(poly[0], poly[1]);
  const h = dist(poly[1], poly[2]);
  if (w < 1.5 || h < 1.5 || w > halfSize * 1.6 || h > halfSize * 1.6) return null;
  return poly;
}

function ribbon(a: Point, b: Point, width: number, maxLen = 80): Point[] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.4 || len > maxLen) return null;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
}

export function assembleCompound(site: {
  mainId: number | null;
  mainRing: Point[];
  structures: { id: number; tag: string; ring: Point[]; area: number }[];
  fences: Point[][];
  pools: Point[][];
  parcel: Point[] | null;
  aerial: { kind: CompoundKind; label?: string; polygon: Point[] }[];
}): { features: SiteFeature[] } {
  const features: SiteFeature[] = [];
  const yard = site.parcel && site.parcel.length >= 3 ? site.parcel : null;
  const main = site.mainRing.length >= 3 ? site.mainRing : null;
  const mainC: Point = main ? ringCentroid(main) : [0, 0];

  const onSite = (p: Point) => {
    if (yard) return pointInRing(p, yard) || distToRing(p, yard) < 3;
    return dist(p, mainC) < 20;
  };

  if (yard) {
    features.push({ id: "lot", kind: "yard", label: "Lot", polygon: yard, height: HEIGHT.yard, source: "parcel" });
  }

  for (const s of site.structures) {
    if (s.id === site.mainId) continue;
    const kind = OUTBUILDING[s.tag];
    if (!kind || s.area < 8 || s.area > 140 || s.ring.length < 3) continue;
    if (!onSite(ringCentroid(s.ring))) continue;
    features.push({
      id: `osm-${s.id}`,
      kind,
      label: LABEL[kind],
      polygon: s.ring,
      height: HEIGHT[kind],
      source: "map",
    });
  }

  site.pools.forEach((ring, i) => {
    if (ring.length < 3 || !onSite(ringCentroid(ring))) return;
    features.push({ id: `pool-${i}`, kind: "pool", label: "Pool", polygon: ring, height: HEIGHT.pool, source: "map" });
  });

  let fenceCount = 0;
  for (const line of site.fences) {
    for (let i = 0; i < line.length - 1 && fenceCount < 40; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!onSite(mid)) continue;
      const polygon = ribbon(a, b, 0.14, 30);
      if (!polygon) continue;
      features.push({
        id: `fence-${fenceCount}`,
        kind: "fence",
        label: "Fence",
        polygon,
        height: HEIGHT.fence,
        source: "map",
      });
      fenceCount++;
    }
  }

  for (const [i, a] of site.aerial.entries()) {
    if (a.polygon.length < 3) continue;
    if (a.kind === "yard" || a.kind === "fence") continue;
    const c = ringCentroid(a.polygon);
    if (main && pointInRing(c, main)) continue;
    if (!onSite(c)) continue;
    if ((a.kind === "garage" || a.kind === "shed") && features.some((f) => (f.kind === "garage" || f.kind === "shed") && dist(ringCentroid(f.polygon), c) < 7)) {
      continue;
    }
    features.push({
      id: `aerial-${i}`,
      kind: a.kind,
      label: a.label?.trim() || LABEL[a.kind],
      polygon: a.polygon,
      height: HEIGHT[a.kind],
      source: "aerial",
    });
  }

  return { features: features.slice(0, 48) };
}

/** How many rooms fit along the depth. One bay is about one window on the long side. */
export function roomBays(depth: number): number {
  return Math.max(2, Math.min(4, Math.round(depth / 4)));
}

const GARAGE_TAGS = new Set(["garage", "garages", "carport", "roof"]);

/** The mapped garage on this lot, if one sits next to the house. */
export function pickGarage(
  structures: { id: number; tag: string; ring: Point[]; area: number }[],
  main: Point,
  parcel: Point[] | null,
): Point[] | null {
  let best: Point[] | null = null;
  let bestD = 22;
  for (const s of structures) {
    if (!GARAGE_TAGS.has(s.tag) || s.area < 8 || s.area > 140 || s.ring.length < 3) continue;
    const c = ringCentroid(s.ring);
    if (parcel && parcel.length >= 3 && !pointInRing(c, parcel) && distToRing(c, parcel) > 4) continue;
    const d = dist(c, main);
    if (d < bestD) {
      best = s.ring;
      bestD = d;
    }
  }
  return best;
}

function nearestOn(p: Point, a: Point, b: Point): { at: Point; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const at: Point = [a[0] + t * dx, a[1] + t * dy];
  return { at, d: dist(p, at) };
}

/**
 * The street in front of the house, and a driveway from that street to the garage
 * or to the front door. Coordinates are already in the model frame.
 */
export function accessFeatures(opts: {
  footprint: Point[];
  streetDir: Point | null;
  roads: { name: string | null; pts: Point[] }[];
  garage: Point[] | null;
}): SiteFeature[] {
  const here: Point = ringCentroid(opts.footprint);
  let best: { a: Point; b: Point; name: string | null; at: Point; d: number } | null = null;
  for (const road of opts.roads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const hit = nearestOn(here, road.pts[i], road.pts[i + 1]);
      if (!best || hit.d < best.d) best = { a: road.pts[i], b: road.pts[i + 1], name: road.name, at: hit.at, d: hit.d };
    }
  }
  if (!best || best.d > 40) return [];

  const dx = best.b[0] - best.a[0];
  const dy = best.b[1] - best.a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const back = Math.min(18, dist(best.a, best.at));
  const fwd = Math.min(18, dist(best.b, best.at));
  const roadA: Point = [best.at[0] - ux * back, best.at[1] - uy * back];
  const roadB: Point = [best.at[0] + ux * fwd, best.at[1] + uy * fwd];
  const out: SiteFeature[] = [];
  const roadPoly = ribbon(roadA, roadB, 7.2);
  if (roadPoly) {
    out.push({
      id: "road",
      kind: "road",
      label: best.name || "Street",
      polygon: roadPoly,
      height: HEIGHT.road,
      source: "map",
    });
  }

  let dir = opts.streetDir;
  const dirLen = dir ? Math.hypot(dir[0], dir[1]) : 0;
  if (!dir || dirLen < 0.5) {
    const vx = best.at[0] - here[0];
    const vy = best.at[1] - here[1];
    const vd = Math.hypot(vx, vy) || 1;
    dir = [vx / vd, vy / vd];
  } else {
    dir = [dir[0] / dirLen, dir[1] / dirLen];
  }
  const side: Point = [-dir[1], dir[0]];
  let halfSide = 0;
  let halfFront = 0;
  for (const p of opts.footprint) {
    halfSide = Math.max(halfSide, Math.abs((p[0] - here[0]) * side[0] + (p[1] - here[1]) * side[1]));
    halfFront = Math.max(halfFront, Math.abs((p[0] - here[0]) * dir[0] + (p[1] - here[1]) * dir[1]));
  }

  let drive: Point[] | null = null;
  if (opts.garage && opts.garage.length >= 3) {
    const g = ringCentroid(opts.garage);
    const sign = Math.sign((g[0] - here[0]) * side[0] + (g[1] - here[1]) * side[1]) || 1;
    const lateral = sign * (halfSide + 1.6);
    const origin: Point = [here[0] + side[0] * lateral, here[1] + side[1] * lateral];
    const along = (g[0] - origin[0]) * -dir[0] + (g[1] - origin[1]) * -dir[1];
    const end: Point = [origin[0] - dir[0] * along, origin[1] - dir[1] * along];
    const mouthTarget: Point = [origin[0] + dir[0] * (halfFront + 1), origin[1] + dir[1] * (halfFront + 1)];
    const mouth = nearestOn(mouthTarget, roadA, roadB).at;
    drive = ribbon(mouth, end, 2.8);
  } else {
    const front: Point = [here[0] + dir[0] * (halfFront + 0.6), here[1] + dir[1] * (halfFront + 0.6)];
    const mouth = nearestOn(front, roadA, roadB).at;
    drive = ribbon(front, mouth, 3);
  }
  if (drive) {
    out.push({ id: "driveway", kind: "driveway", label: "Driveway", polygon: drive, height: HEIGHT.driveway, source: "map" });
  }
  return out;
}
