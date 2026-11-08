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
  | "hydrant"
  | "neighbor";

export type SiteFeature = {
  id: string;
  kind: CompoundKind;
  label: string;
  polygon: Point[];
  height: number;
  source: "map" | "aerial" | "parcel" | "estimated";
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

/** Peer dwellings / attached units — drawn as ghost shells, not focus interiors. */
const HOUSE_LIKE = new Set([
  "yes",
  "house",
  "residential",
  "apartments",
  "detached",
  "terrace",
  "semidetached_house",
  "bungalow",
  "static_caravan",
  "dormitory",
  "maisonette",
  "allotment_house",
]);

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
  neighbor: 6.5,
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
  neighbor: "Neighbor",
};

function isHouseLike(tag: string, area: number): boolean {
  if (OUTBUILDING[tag]) return false;
  if (!HOUSE_LIKE.has(tag)) return false;
  // Generic building=yes is common on sheds — require a house-sized pad.
  const minArea = tag === "yes" ? 55 : 40;
  return area >= minArea && area <= 4000;
}

/**
 * Neighbor shells: tagged houses, or untagged building=yes pads that clearly touch / sit next door.
 * Centroid checks alone miss large attached wings whose center sits far from our wall.
 */
function isNeighborCandidate(tag: string, area: number, separationM: number): boolean {
  if (OUTBUILDING[tag]) return false;
  if (area < 35 || area > 4000) return false;
  if (isHouseLike(tag, area)) return true;
  // Close, house-sized, but tagged only as building=yes / missing tag — still a dwelling obstacle.
  if ((tag === "yes" || !tag) && separationM <= 14 && area >= 40) return true;
  return false;
}

/** Shortest gap between two rings (0 if they touch or overlap). */
export function ringSeparation(a: Point[], b: Point[]): number {
  if (a.length < 3 || b.length < 3) return Infinity;
  for (const p of a) if (pointInRing(p, b)) return 0;
  for (const p of b) if (pointInRing(p, a)) return 0;
  let best = Infinity;
  for (const p of a) best = Math.min(best, distToRing(p, b));
  for (const p of b) best = Math.min(best, distToRing(p, a));
  return best;
}

/** Reach for ghost neighbor shells — wider than garages so attached / next-door units show. */
export function neighborReach(mainRing: Point[]): number {
  const ext = foundationExtent(mainRing);
  const accessory = accessoryReach(mainRing);
  // Room for large attached wings whose far wall sits well past the old centroid check.
  return Math.min(120, Math.max(accessory * 1.55, ext * 2.1 + 18));
}

export type NeighborHeightInput = {
  /** OSM building:levels when mapped. */
  levels?: number | null;
  /** OSM height in meters when mapped (often includes roof). */
  heightM?: number | null;
  /** Eave height of the focus house (meters) — default match for attached peers. */
  mainEave: number;
};

/**
 * Ghost-shell height for a neighbor: prefer OSM levels/height, else match the scanned house eave.
 * Avoids the old √area guess that made wide 1-story pads look like towers.
 */
export function neighborShellHeight(input: NeighborHeightInput): number {
  const clamp = (h: number) => Math.min(14, Math.max(3.5, h));
  const levels = input.levels != null && Number.isFinite(input.levels) ? Math.round(input.levels) : null;
  if (levels != null && levels >= 1 && levels <= 8) return clamp(levels * 2.75);
  const hm = input.heightM != null && Number.isFinite(input.heightM) ? input.heightM : null;
  if (hm != null && hm >= 2.5) {
    // Mapped height often includes the roof; shell stops near the eaves.
    return clamp(hm * 0.88);
  }
  return clamp(input.mainEave > 2 ? input.mainEave : 5.5);
}

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

/** Characteristic foundation size from the model origin (meters). */
export function foundationExtent(mainRing: Point[]): number {
  if (mainRing.length < 3) return 10;
  return Math.max(...mainRing.map(([x, y]) => Math.hypot(x, y)), 6);
}

/**
 * How far from the main building yard / street / aerial search should reach (meters).
 * Scales with foundation size so a cottage and a campus don't share one city-block radius.
 */
export function compoundReach(mainRing: Point[]): number {
  const ext = foundationExtent(mainRing);
  return Math.min(160, Math.max(40, ext * 2.8 + 18));
}

/**
 * How far a garage/shed may sit from the foundation edge (meters).
 * Tighter than compoundReach so off-lot and far campus buildings are not drawn as "garages".
 */
export function accessoryReach(mainRing: Point[]): number {
  const ext = foundationExtent(mainRing);
  return Math.min(70, Math.max(16, ext * 1.25 + 10));
}

/** True when point is inside the foundation or within `r` meters of its outline. */
function nearFoundation(p: Point, main: Point[] | null, r: number): boolean {
  if (!main || main.length < 3) return Math.hypot(p[0], p[1]) < r;
  return pointInRing(p, main) || distToRing(p, main) < r;
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

function treePad(p: Point, s = 0.85): Point[] {
  return [
    [p[0] - s, p[1] - s],
    [p[0] + s, p[1] - s],
    [p[0] + s, p[1] + s],
    [p[0] - s, p[1] + s],
  ];
}

/** True when `p` sits on the backyard side of the house (opposite the street). */
function inBackyard(p: Point, houseC: Point, streetDir: Point | null): boolean {
  const back: Point = streetDir ? [-streetDir[0], -streetDir[1]] : [0, 1];
  const len = Math.hypot(back[0], back[1]) || 1;
  const dx = p[0] - houseC[0];
  const dy = p[1] - houseC[1];
  return (dx * back[0] + dy * back[1]) / len > 0.5;
}

export function assembleCompound(site: {
  mainId: number | null;
  mainRing: Point[];
  structures: { id: number; tag: string; ring: Point[]; area: number; levels?: number | null; heightM?: number | null }[];
  fences: Point[][];
  pools: Point[][];
  parking?: Point[][];
  parcel: Point[] | null;
  aerial: { kind: CompoundKind; label?: string; polygon: Point[] }[];
  /** Focus-house eave height (m) so neighbors without OSM height match the scanned shell. */
  mainEaveHeight?: number;
  /** Unit vector toward the street — used to place backyard fence/trees. */
  streetDir?: Point | null;
  /** Mapped OSM tree trunks (local meters). */
  trees?: Point[];
}): { features: SiteFeature[] } {
  const features: SiteFeature[] = [];
  const main = site.mainRing.length >= 3 ? site.mainRing : null;
  const mainC: Point = main ? ringCentroid(main) : [0, 0];
  const streetDir = site.streetDir ?? null;
  const reach = compoundReach(site.mainRing);
  const accessoryR = accessoryReach(site.mainRing);
  const neighborR = neighborReach(site.mainRing);
  const lotSoft = Math.min(6, Math.max(2.5, foundationExtent(site.mainRing) * 0.12));
  const maxOut = Math.max(120, Math.min(500, accessoryR * accessoryR * 0.12));
  const maxNeighborArea = Math.max(800, Math.min(4000, foundationExtent(site.mainRing) * foundationExtent(site.mainRing) * 4));

  // Prefer the tax lot; otherwise hull the house + nearby tagged outbuildings/parking.
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
          nearFoundation(ringCentroid(s.ring), main, accessoryR),
      )
      .map((s) => s.ring);
    yard = siteHull([main, ...nearRings, ...(site.parking ?? []), ...site.pools], Math.max(3, Math.min(8, accessoryR * 0.12)));
    yardSource = "map";
  }

  const onSite = (p: Point) => {
    if (yard) return pointInRing(p, yard) || distToRing(p, yard) < lotSoft;
    return nearFoundation(p, main, accessoryR);
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
    // Even on a huge campus parcel, only keep accessories near this foundation.
    if (!nearFoundation(c, main, accessoryR)) continue;
    // House-like peers are handled as ghost neighbors, not fake garages.
    if (isHouseLike(s.tag, s.area)) continue;
    let kind = OUTBUILDING[s.tag];
    // On a mapped tax lot, untagged buildings next to the house can be accessory pads.
    if (!kind && hasParcel && nearFoundation(c, main, Math.min(accessoryR, Math.max(18, accessoryR * 0.65)))) {
      kind = s.area >= 40 ? "garage" : "shed";
    }
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

  // Attached / next-door dwellings: ghost shells so they read as obstacles, not the focus house.
  // Use ring-to-ring gap (not centroid) so large attached wings still qualify.
  const neighborHits = site.structures
    .filter((s) => {
      if (s.id === site.mainId || s.ring.length < 3) return false;
      if (s.area > maxNeighborArea) return false;
      const sep = main ? ringSeparation(main, s.ring) : dist(ringCentroid(s.ring), mainC);
      if (sep > neighborR) return false;
      return isNeighborCandidate(s.tag, s.area, sep);
    })
    .map((s) => ({
      s,
      d: main ? ringSeparation(main, s.ring) : dist(ringCentroid(s.ring), mainC),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 10);
  const neighborRings = neighborHits.map((h) => h.s.ring);
  const neighborSoft = Math.min(30, Math.max(14, accessoryR * 0.9));
  const nearNeighborhood = (p: Point) =>
    onSite(p) || neighborRings.some((r) => nearFoundation(p, r, neighborSoft));

  const mainEave = site.mainEaveHeight && site.mainEaveHeight > 2 ? site.mainEaveHeight : 5.5;
  for (const { s } of neighborHits) {
    const h = neighborShellHeight({
      levels: s.levels,
      heightM: s.heightM,
      mainEave,
    });
    features.push({
      id: `neighbor-${s.id}`,
      kind: "neighbor",
      label: LABEL.neighbor,
      polygon: s.ring,
      height: h,
      source: "map",
    });
  }

  // Neighbor accessories (garage/shed on their lot) — obstacle context, not focus-house pads.
  for (const s of site.structures) {
    if (s.id === site.mainId) continue;
    if (s.ring.length < 3 || s.area < 8 || s.area > maxOut) continue;
    if (isHouseLike(s.tag, s.area) || isNeighborCandidate(s.tag, s.area, 0)) continue;
    const kind = OUTBUILDING[s.tag];
    if (!kind) continue;
    const c = ringCentroid(s.ring);
    if (onSite(c) && nearFoundation(c, main, accessoryR)) continue; // already added above
    if (!neighborRings.some((r) => nearFoundation(c, r, neighborSoft))) continue;
    if (features.some((f) => f.id === `osm-${s.id}`)) continue;
    features.push({
      id: `osm-nbr-${s.id}`,
      kind,
      label: LABEL[kind],
      polygon: s.ring,
      height: HEIGHT[kind],
      source: "map",
    });
  }

  site.pools.forEach((ring, i) => {
    if (ring.length < 3 || !nearNeighborhood(ringCentroid(ring))) return;
    features.push({ id: `pool-${i}`, kind: "pool", label: "Pool", polygon: ring, height: HEIGHT.pool, source: "map" });
  });

  (site.parking ?? []).forEach((ring, i) => {
    if (ring.length < 3 || !nearNeighborhood(ringCentroid(ring))) return;
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
  const fenceCap = Math.min(160, Math.max(50, Math.round(reach * 1.2)));
  for (const line of site.fences) {
    for (let i = 0; i < line.length - 1 && fenceCount < fenceCap; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!nearNeighborhood(mid)) continue;
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

  let treeCount = 0;
  const treeCap = 40;
  for (const p of site.trees ?? []) {
    if (treeCount >= treeCap) break;
    if (!nearNeighborhood(p)) continue;
    if (main && (pointInRing(p, main) || distToRing(p, main) < 1.2)) continue;
    if (neighborRings.some((r) => pointInRing(p, r) || distToRing(p, r) < 1.0)) continue;
    features.push({
      id: `tree-map-${treeCount}`,
      kind: "trees",
      label: "Tree",
      polygon: treePad(p),
      height: HEIGHT.trees,
      source: "map",
    });
    treeCount++;
  }

  for (const [i, a] of site.aerial.entries()) {
    if (a.polygon.length < 3) continue;
    if (a.kind === "yard" || a.kind === "fence") continue;
    const c = ringCentroid(a.polygon);
    if (main && pointInRing(c, main)) continue;
    if (!nearNeighborhood(c)) continue;
    if ((a.kind === "garage" || a.kind === "shed") && !nearFoundation(c, main, accessoryR) && !neighborRings.some((r) => nearFoundation(c, r, neighborSoft))) {
      continue;
    }
    if ((a.kind === "garage" || a.kind === "shed") && features.some((f) => (f.kind === "garage" || f.kind === "shed") && dist(ringCentroid(f.polygon), c) < 7)) {
      continue;
    }
    if (a.kind === "trees") {
      if (treeCount >= treeCap) continue;
      treeCount++;
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

  // --- Backyard fill: mapped data first; invent only when the rear lot is still empty. ---
  const yardRing = yard && yard.length >= 3 ? yard : null;
  const backFenceN = features.filter(
    (f) => f.kind === "fence" && inBackyard(ringCentroid(f.polygon), mainC, streetDir),
  ).length;
  const backTreeN = features.filter(
    (f) => f.kind === "trees" && inBackyard(ringCentroid(f.polygon), mainC, streetDir),
  ).length;

  if (backFenceN < 2 && yardRing) {
    const ring = yardRing;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inBackyard(mid, mainC, streetDir)) continue;
      // Skip edges that hug the house (interior lot lines).
      if (main && distToRing(mid, main) < 1.5) continue;
      const polygon = ribbon(a, b, 0.14, Math.max(40, reach * 0.6));
      if (!polygon) continue;
      if (fenceCount >= fenceCap) break;
      features.push({
        id: `fence-est-${fenceCount}`,
        kind: "fence",
        label: "Fence",
        polygon,
        height: HEIGHT.fence,
        source: "estimated",
      });
      fenceCount++;
    }
  }

  if (backTreeN === 0 && treeCount < treeCap) {
    const back: Point = streetDir ? [-streetDir[0], -streetDir[1]] : [0, 1];
    const bLen = Math.hypot(back[0], back[1]) || 1;
    const bu: Point = [back[0] / bLen, back[1] / bLen];
    const side: Point = [-bu[1], bu[0]];
    const ext = foundationExtent(site.mainRing);
    const depth = Math.min(14, Math.max(6, ext * 0.55));
    const candidates: Point[] = [
      [mainC[0] + bu[0] * depth, mainC[1] + bu[1] * depth],
      [mainC[0] + bu[0] * (depth * 0.7) + side[0] * (ext * 0.35), mainC[1] + bu[1] * (depth * 0.7) + side[1] * (ext * 0.35)],
      [mainC[0] + bu[0] * (depth * 0.7) - side[0] * (ext * 0.35), mainC[1] + bu[1] * (depth * 0.7) - side[1] * (ext * 0.35)],
      [mainC[0] + bu[0] * (depth * 1.15) + side[0] * (ext * 0.15), mainC[1] + bu[1] * (depth * 1.15) + side[1] * (ext * 0.15)],
    ];
    let estTrees = 0;
    for (const p of candidates) {
      if (estTrees >= 3 || treeCount >= treeCap) break;
      if (!onSite(p)) continue;
      if (main && (pointInRing(p, main) || distToRing(p, main) < 2)) continue;
      if (!inBackyard(p, mainC, streetDir)) continue;
      // Avoid pools / driveways / outbuildings already placed.
      if (
        features.some((f) => {
          if (f.kind === "yard" || f.kind === "fence" || f.kind === "trees" || f.kind === "neighbor") return false;
          return pointInRing(p, f.polygon) || distToRing(p, f.polygon) < 1.5;
        })
      ) {
        continue;
      }
      features.push({
        id: `tree-est-${estTrees}`,
        kind: "trees",
        label: "Tree",
        polygon: treePad(p),
        height: HEIGHT.trees,
        source: "estimated",
      });
      estTrees++;
      treeCount++;
    }
  }

  // Neighbor backyard obstacles — mapped first; light estimated fence/trees when their rear is empty.
  const back: Point = streetDir ? [-streetDir[0], -streetDir[1]] : [0, 1];
  const bLen = Math.hypot(back[0], back[1]) || 1;
  const bu: Point = [back[0] / bLen, back[1] / bLen];
  const side: Point = [-bu[1], bu[0]];
  let nbrEst = 0;
  for (const { s } of neighborHits.slice(0, 6)) {
    const nc = ringCentroid(s.ring);
    const nExt = foundationExtent(s.ring.map(([x, y]) => [x - nc[0], y - nc[1]] as Point));
    const soft = Math.min(18, Math.max(8, nExt * 0.9));
    const nBackFences = features.filter(
      (f) =>
        f.kind === "fence" &&
        inBackyard(ringCentroid(f.polygon), nc, streetDir) &&
        nearFoundation(ringCentroid(f.polygon), s.ring, soft),
    ).length;
    const nBackTrees = features.filter(
      (f) =>
        f.kind === "trees" &&
        inBackyard(ringCentroid(f.polygon), nc, streetDir) &&
        nearFoundation(ringCentroid(f.polygon), s.ring, soft),
    ).length;

    if (nBackFences < 2 && fenceCount < fenceCap) {
      const depth = Math.min(12, Math.max(5, nExt * 0.7));
      const half = Math.min(8, Math.max(3.5, nExt * 0.55));
      const rear: Point = [nc[0] + bu[0] * depth, nc[1] + bu[1] * depth];
      const left: Point = [rear[0] + side[0] * half, rear[1] + side[1] * half];
      const right: Point = [rear[0] - side[0] * half, rear[1] - side[1] * half];
      // U-shaped backyard fence: left post → rear span → right post, offset from the shell.
      const nearLeft: Point = [nc[0] + bu[0] * (depth * 0.35) + side[0] * half, nc[1] + bu[1] * (depth * 0.35) + side[1] * half];
      const nearRight: Point = [nc[0] + bu[0] * (depth * 0.35) - side[0] * half, nc[1] + bu[1] * (depth * 0.35) - side[1] * half];
      for (const [a, b] of [
        [nearLeft, left],
        [left, right],
        [right, nearRight],
      ] as [Point, Point][]) {
        if (fenceCount >= fenceCap) break;
        // Don't draw through the focus house.
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (main && (pointInRing(mid, main) || distToRing(mid, main) < 1.2)) continue;
        const polygon = ribbon(a, b, 0.12, 40);
        if (!polygon) continue;
        features.push({
          id: `fence-nbr-${s.id}-${fenceCount}`,
          kind: "fence",
          label: "Fence",
          polygon,
          height: HEIGHT.fence,
          source: "estimated",
        });
        fenceCount++;
      }
    }

    if (nBackTrees === 0 && treeCount < treeCap) {
      const depth = Math.min(11, Math.max(5, nExt * 0.65));
      const half = Math.min(5, Math.max(2.5, nExt * 0.35));
      const spots: Point[] = [
        [nc[0] + bu[0] * depth, nc[1] + bu[1] * depth],
        [nc[0] + bu[0] * (depth * 0.85) + side[0] * half, nc[1] + bu[1] * (depth * 0.85) + side[1] * half],
      ];
      for (const p of spots) {
        if (treeCount >= treeCap) break;
        if (main && (pointInRing(p, main) || distToRing(p, main) < 2)) continue;
        if (pointInRing(p, s.ring) || distToRing(p, s.ring) < 1.5) continue;
        if (!inBackyard(p, nc, streetDir)) continue;
        features.push({
          id: `tree-nbr-${s.id}-${nbrEst++}`,
          kind: "trees",
          label: "Tree",
          polygon: treePad(p),
          height: HEIGHT.trees,
          source: "estimated",
        });
        treeCount++;
      }
    }
  }

  return { features: features.slice(0, 180) };
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

  // Street hydrants are often 100–250 m from the house — keep a wide net independent of road clip.
  const hydrantR = 320;
  const nearestHydrants = [...(opts.hydrants ?? [])]
    .map((p) => ({ p, d: dist(here, p) }))
    .filter((h) => h.d < hydrantR)
    .sort((a, b) => a.d - b.d)
    .slice(0, 40);
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
