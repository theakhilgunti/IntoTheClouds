/** Lot, outbuilding, and aerial-box geometry. No app imports, so node:test can load it. */
export type Point = [number, number];

export type CompoundKind =
  | "yard"
  | "garage"
  | "shed"
  | "driveway"
  | "patio"
  | "pool"
  | "fence"
  | "trees"
  | "road"
  | "signal"
  | "hydrant";

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
  warehouse: "shed",
  industrial: "shed",
  service: "shed",
  farm_auxiliary: "shed",
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
  signal: 3.2,
  hydrant: 0.85,
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
  signal: "Traffic light",
  hydrant: "Fire hydrant",
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
  if (w < 1.5 || h < 1.5 || w > halfSize * 1.85 || h > halfSize * 1.85) return null;
  return poly;
}

function ribbon(a: Point, b: Point, width: number, maxLen = 320): Point[] | null {
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

/** How far from the main building the compound search should reach, in meters. */
export function compoundReach(mainRing: Point[]): number {
  if (mainRing.length < 3) return 55;
  const extent = Math.max(...mainRing.map(([x, y]) => Math.hypot(x, y)), 8);
  return Math.min(220, Math.max(55, extent * 3.6));
}

function ringExtent(ring: Point[]): number {
  if (ring.length < 1) return 8;
  return Math.max(...ring.map(([x, y]) => Math.hypot(x, y)), 8);
}

/** Convex hull (monotone chain), then push vertices outward for a soft yard pad. */
export function siteHull(rings: Point[][], pad = 4): Point[] | null {
  const pts: Point[] = [];
  for (const ring of rings) for (const p of ring) pts.push(p);
  if (pts.length < 3) return null;
  const sorted = [...pts].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return null;
  const c = ringCentroid(hull);
  return hull.map(([x, y]) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * pad, y + (dy / len) * pad] as Point;
  });
}

export function assembleCompound(site: {
  mainId: number | null;
  mainRing: Point[];
  structures: { id: number; tag: string; ring: Point[]; area: number }[];
  fences: Point[][];
  pools: Point[][];
  parking?: Point[][];
  parcel: Point[] | null;
  aerial: { kind: CompoundKind; label?: string; polygon: Point[] }[];
}): { features: SiteFeature[] } {
  const features: SiteFeature[] = [];
  const main = site.mainRing.length >= 3 ? site.mainRing : null;
  const mainC: Point = main ? ringCentroid(main) : [0, 0];
  const reach = compoundReach(site.mainRing);
  const maxOut = Math.max(140, Math.min(800, reach * reach * 0.08));

  // Prefer the tax lot; otherwise hull the house + tagged outbuildings/parking so large sites still get a yard.
  const hasParcel = !!(site.parcel && site.parcel.length >= 3);
  let yard = hasParcel ? site.parcel : null;
  let yardSource: "parcel" | "map" = "parcel";
  if (!yard && main) {
    const nearRings = site.structures
      .filter(
        (s) =>
          s.id !== site.mainId &&
          s.ring.length >= 3 &&
          !!OUTBUILDING[s.tag] &&
          s.area >= 8 &&
          s.area <= maxOut &&
          dist(ringCentroid(s.ring), mainC) < reach,
      )
      .map((s) => s.ring);
    yard = siteHull([main, ...nearRings, ...(site.parking ?? []), ...site.pools], Math.max(4, reach * 0.08));
    yardSource = "map";
  }

  const onSite = (p: Point) => {
    if (yard) return pointInRing(p, yard) || distToRing(p, yard) < Math.max(4, reach * 0.06);
    return dist(p, mainC) < reach;
  };

  if (yard) {
    features.push({
      id: "lot",
      kind: "yard",
      label: yardSource === "parcel" ? "Lot" : "Site",
      polygon: yard,
      height: HEIGHT.yard,
      source: yardSource,
    });
  }

  for (const s of site.structures) {
    if (s.id === site.mainId) continue;
    if (s.ring.length < 3 || s.area < 8 || s.area > maxOut) continue;
    const c = ringCentroid(s.ring);
    if (!onSite(c)) continue;
    let kind = OUTBUILDING[s.tag];
    // On a mapped tax lot, keep other accessory buildings; without a lot, only tagged outbuildings.
    if (!kind && hasParcel) kind = s.area >= 40 ? "garage" : "shed";
    if (!kind) continue;
    const label =
      kind === "garage" && (s.tag === "garage" || s.tag === "garages" || s.tag === "carport")
        ? LABEL.garage
        : s.tag && s.tag !== "yes" && !OUTBUILDING[s.tag]
          ? s.tag.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase())
          : LABEL[kind];
    features.push({
      id: `osm-${s.id}`,
      kind,
      label,
      polygon: s.ring,
      height: HEIGHT[kind],
      source: "map",
    });
  }

  site.pools.forEach((ring, i) => {
    if (ring.length < 3 || !onSite(ringCentroid(ring))) return;
    features.push({ id: `pool-${i}`, kind: "pool", label: "Pool", polygon: ring, height: HEIGHT.pool, source: "map" });
  });

  (site.parking ?? []).forEach((ring, i) => {
    if (ring.length < 3 || !onSite(ringCentroid(ring))) return;
    features.push({
      id: `parking-${i}`,
      kind: "driveway",
      label: "Parking",
      polygon: ring,
      height: HEIGHT.driveway,
      source: "map",
    });
  });

  let fenceCount = 0;
  const fenceCap = Math.min(120, Math.max(40, Math.round(reach)));
  for (const line of site.fences) {
    for (let i = 0; i < line.length - 1 && fenceCount < fenceCap; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!onSite(mid)) continue;
      const polygon = ribbon(a, b, 0.14, Math.max(30, reach * 0.5));
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

  return { features: features.slice(0, 120) };
}

/**
 * Cross-check mapped site features against aerial / satellite cues (Esri JPEG + Gemini boxes).
 * Keeps OSM when aerial agrees or is silent; drops map outbuildings contradicted by clear aerial
 * evidence; fills gaps from aerial when the map omitted them.
 */
export function crossVerifySiteFeatures(opts: {
  features: SiteFeature[];
  aerialCues: { kind: CompoundKind; label?: string; polygon: Point[]; confidence?: number }[];
  /** Gemini house-level garage reading, when available. */
  geminiGarage?: "none" | "attached_left" | "attached_right" | "detached" | "unknown";
}): SiteFeature[] {
  const out = [...opts.features];
  const cues = opts.aerialCues.filter((c) => c.polygon.length >= 3);
  const cueNear = (kind: CompoundKind, p: Point, maxD: number) =>
    cues.some((c) => c.kind === kind && dist(ringCentroid(c.polygon), p) < maxD);

  // Drop mapped garages/sheds that aerial clearly contradicts.
  const filtered = out.filter((f) => {
    if (f.kind !== "garage" && f.kind !== "shed") return true;
    if (f.source === "aerial") return true;
    const c = ringCentroid(f.polygon);
    const aerialSeesOutbuilding = cues.some((q) => (q.kind === "garage" || q.kind === "shed") && (q.confidence ?? 0.5) >= 0.4);
    if (!aerialSeesOutbuilding) {
      // No aerial outbuilding signal — keep OSM, unless Gemini says none and this is a weak far shed.
      if (opts.geminiGarage === "none" && f.kind === "shed") return false;
      return true;
    }
    // Aerial has outbuildings somewhere — keep this one only if a cue sits nearby.
    return cueNear("garage", c, 10) || cueNear("shed", c, 10);
  });

  // Add aerial cues the map missed.
  let addN = 0;
  for (const cue of cues) {
    if (cue.kind === "yard" || cue.kind === "fence" || cue.kind === "road" || cue.kind === "signal" || cue.kind === "hydrant") continue;
    if ((cue.confidence ?? 0.5) < 0.4) continue;
    const c = ringCentroid(cue.polygon);
    const dup = filtered.some(
      (f) =>
        (f.kind === cue.kind || ((f.kind === "garage" || f.kind === "shed") && (cue.kind === "garage" || cue.kind === "shed"))) &&
        dist(ringCentroid(f.polygon), c) < 8,
    );
    if (dup) continue;
    if (opts.geminiGarage === "none" && (cue.kind === "garage" || cue.kind === "shed")) continue;
    filtered.push({
      id: `verify-aerial-${addN++}`,
      kind: cue.kind,
      label: cue.label?.trim() || LABEL[cue.kind],
      polygon: cue.polygon,
      height: HEIGHT[cue.kind],
      source: "aerial",
    });
  }

  return filtered.slice(0, 140);
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
  reach = 40,
): Point[] | null {
  let best: Point[] | null = null;
  let bestD = Math.max(22, reach * 0.7);
  const maxArea = Math.max(140, Math.min(600, reach * 4));
  for (const s of structures) {
    if (!GARAGE_TAGS.has(s.tag) || s.area < 8 || s.area > maxArea || s.ring.length < 3) continue;
    const c = ringCentroid(s.ring);
    if (parcel && parcel.length >= 3 && !pointInRing(c, parcel) && distToRing(c, parcel) > 6) continue;
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

/** Circle–segment hits (0..1 params), sorted. */
function circleHits(a: Point, b: Point, origin: Point, radius: number): number[] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const ox = a[0] - origin[0],
    oy = a[1] - origin[1];
  const A = dx * dx + dy * dy || 1;
  const B = 2 * (ox * dx + oy * dy);
  const C = ox * ox + oy * oy - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
}

/** Keep a long stretch of a polyline around the house (full 360 neighborhood). */
function clipRoadNear(pts: Point[], origin: Point, radius: number): Point[] {
  if (pts.length < 2) return [];
  const inside = (p: Point) => dist(p, origin) <= radius;
  const out: Point[] = [];
  const pushUnique = (p: Point) => {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 0.35) out.push(p);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ain = inside(a);
    const bin = inside(b);
    const hits = circleHits(a, b, origin, radius);
    if (ain) pushUnique(a);
    for (const t of hits) pushUnique([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (bin) pushUnique(b);
  }
  return out;
}

function segIntersect(a: Point, b: Point, c: Point, d: Point): Point | null {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const ex = d[0] - c[0],
    ey = d[1] - c[1];
  const det = dx * ey - dy * ex;
  if (Math.abs(det) < 1e-8) return null;
  const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det;
  const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
  if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) return null;
  return [a[0] + dx * t, a[1] + dy * t];
}

/**
 * Long street ribbons in a wide radius (main + connecting roads), driveway to the
 * garage/front, and traffic lights where mapped roads cross.
 */
export function accessFeatures(opts: {
  footprint: Point[];
  streetDir: Point | null;
  roads: { name: string | null; pts: Point[] }[];
  garage: Point[] | null;
  /** Fire hydrant positions in the model frame (meters). */
  hydrants?: Point[];
}): SiteFeature[] {
  const here: Point = ringCentroid(opts.footprint);
  const reach = compoundReach(opts.footprint);
  const keepR = Math.max(70, Math.min(140, reach * 1.15));
  const roadMax = Math.max(55, reach * 1.25);
  const width = Math.min(12, Math.max(7.2, ringExtent(opts.footprint) * 0.15));
  const out: SiteFeature[] = [];

  // Street hydrants are often 100–200 m from the house centroid — keep a wide net.
  const hydrantR = Math.max(250, keepR * 2.2);
  const nearestHydrants = [...(opts.hydrants ?? [])]
    .map((p) => ({ p, d: dist(here, p) }))
    .filter((h) => h.d < hydrantR)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  nearestHydrants.forEach((h, i) => {
    const s = 0.45;
    out.push({
      id: `hydrant-${i}`,
      kind: "hydrant",
      label: i === 0 ? "Nearest hydrant" : "Fire hydrant",
      polygon: [
        [h.p[0] - s, h.p[1] - s],
        [h.p[0] + s, h.p[1] - s],
        [h.p[0] + s, h.p[1] + s],
        [h.p[0] - s, h.p[1] + s],
      ],
      height: HEIGHT.hydrant,
      source: "map",
    });
  });

  type Seg = { a: Point; b: Point; name: string | null };
  const segs: Seg[] = [];
  let roadIdx = 0;
  for (const road of opts.roads) {
    const clipped = clipRoadNear(road.pts, here, keepR);
    if (clipped.length < 2) continue;
    // Prefer lengthy continuous ribbons — merge consecutive short edges when nearly colinear.
    let runStart = clipped[0];
    for (let i = 0; i < clipped.length - 1; i++) {
      const a = clipped[i];
      const b = clipped[i + 1];
      if (dist(a, b) < 0.5) continue;
      const next = clipped[i + 2];
      const continueRun =
        next &&
        (() => {
          const d0: Point = [b[0] - a[0], b[1] - a[1]];
          const d1: Point = [next[0] - b[0], next[1] - b[1]];
          const l0 = Math.hypot(d0[0], d0[1]) || 1;
          const l1 = Math.hypot(d1[0], d1[1]) || 1;
          return (d0[0] / l0) * (d1[0] / l1) + (d0[1] / l0) * (d1[1] / l1) > 0.97;
        })();
      if (continueRun) continue;
      const poly = ribbon(runStart, b, width);
      const nearHouse = nearestOn(here, runStart, b).d < keepR * 1.05;
      if (poly && nearHouse) {
        out.push({
          id: `road-${roadIdx++}`,
          kind: "road",
          label: road.name || "Street",
          polygon: poly,
          height: HEIGHT.road,
          source: "map",
        });
        segs.push({ a: runStart, b, name: road.name });
      }
      runStart = b;
    }
  }

  // Nearest segment for driveway mouth.
  let best: { a: Point; b: Point; name: string | null; at: Point; d: number } | null = null;
  for (const s of segs) {
    const hit = nearestOn(here, s.a, s.b);
    if (!best || hit.d < best.d) best = { a: s.a, b: s.b, name: s.name, at: hit.at, d: hit.d };
  }
  if (!best || best.d > roadMax) {
    // Still keep any road ribbons we already built; no driveway if nothing is close.
    return out;
  }

  // Traffic lights at road crossings near the house.
  let signalN = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const hit = segIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (!hit || dist(hit, here) > keepR * 0.95) continue;
      // Skip near-duplicates.
      if (out.some((f) => f.kind === "signal" && dist(ringCentroid(f.polygon), hit) < 8)) continue;
      const s = 0.55;
      out.push({
        id: `signal-${signalN++}`,
        kind: "signal",
        label: "Traffic light",
        polygon: [
          [hit[0] - s, hit[1] - s],
          [hit[0] + s, hit[1] - s],
          [hit[0] + s, hit[1] + s],
          [hit[0] - s, hit[1] + s],
        ],
        height: HEIGHT.signal,
        source: "map",
      });
      if (signalN >= 4) break;
    }
    if (signalN >= 4) break;
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
    const mouth = nearestOn(mouthTarget, best.a, best.b).at;
    drive = ribbon(mouth, end, 2.8);
  } else {
    const front: Point = [here[0] + dir[0] * (halfFront + 0.6), here[1] + dir[1] * (halfFront + 0.6)];
    const mouth = nearestOn(front, best.a, best.b).at;
    drive = ribbon(front, mouth, 3);
  }
  if (drive) {
    out.push({ id: "driveway", kind: "driveway", label: "Driveway", polygon: drive, height: HEIGHT.driveway, source: "map" });
  }
  return out;
}
