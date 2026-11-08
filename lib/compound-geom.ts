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
  | "neighbor"
  | "steps"
  | "terrain";

export type SiteFeature = {
  id: string;
  kind: CompoundKind;
  label: string;
  polygon: Point[];
  height: number;
  source: "map" | "aerial" | "parcel" | "estimated";
};

/** DEM heightfield in the model frame (heights relative to the house slab). */
export type DemGrid = {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  z: number[];
  source: string;
};

/** Mild lot tilt (+ optional real DEM). House slab stays at y = 0. */
export type LotGrade = {
  downhill: Point;
  slope: number;
  origin: Point;
  /** Real outdoor elevation samples; preferred over the plane when present. */
  dem?: DemGrid;
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
  driveway: 0.06,
  patio: 0.14,
  pool: 0.2,
  fence: 1.05,
  trees: 4,
  road: 0.1,
  signal: 3.2,
  hydrant: 0.85,
  neighbor: 6.5,
  steps: 0.18,
  terrain: 0.04,
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
  steps: "Entry stairs",
  terrain: "Ground",
};

/** Push ring vertices outward from the centroid (meters). */
export function expandRing(ring: Point[], pad: number): Point[] {
  if (ring.length < 3 || pad <= 0) return ring.map((p) => [p[0], p[1]] as Point);
  const c = ringCentroid(ring);
  return ring.map(([x, y]) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * pad, y + (dy / len) * pad] as Point;
  });
}

/** Approximate a circle in the model frame (for the rendered-neighborhood ground disc). */
export function circlePoly(center: Point, radius: number, sides = 48): Point[] {
  const n = Math.max(12, Math.min(64, Math.round(sides)));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
  }
  return out;
}

/**
 * Graded ground under the focus house + neighbors, plus a disc covering the
 * neighbor render radius so topology reads across the whole scene.
 */
export function neighborhoodTerrainFeatures(
  main: Point[] | null,
  neighborRings: Point[][],
  radiusM?: number,
): SiteFeature[] {
  const out: SiteFeature[] = [];
  const origin: Point = main && main.length >= 3 ? ringCentroid(main) : [0, 0];
  const radius = Math.max(SITE_REACH_MIN_M, radiusM ?? (main ? siteReach(main) : SITE_REACH_MIN_M));

  // Full rendered-radius disc first (drawn under everything else).
  out.push({
    id: "terrain-radius",
    kind: "terrain",
    label: "Neighborhood grade",
    polygon: circlePoly(origin, radius, 48),
    height: HEIGHT.terrain * 0.55,
    source: "estimated",
  });

  // Focus house has no solid pad — the warped grid / DEM mesh already reads the ground.
  neighborRings.forEach((ring, i) => {
    if (ring.length < 3) return;
    out.push({
      id: `terrain-nbr-${i}`,
      kind: "terrain",
      label: "Neighbor pad",
      polygon: expandRing(ring, 2.4),
      height: HEIGHT.terrain,
      source: "estimated",
    });
  });
  return out;
}

/** Build a gentle street→backyard grade so outdoor pads read as terrain, not a flat table. */
export function buildLotGrade(footprint: Point[], streetDir: Point | null): LotGrade | null {
  if (footprint.length < 3) return null;
  const raw = streetDir ?? ([0, -1] as Point);
  const len = Math.hypot(raw[0], raw[1]) || 1;
  return {
    downhill: [raw[0] / len, raw[1] / len],
    // ~3.5% — readable from orbit without cartoon cliffs.
    slope: 0.035,
    origin: ringCentroid(footprint),
  };
}

/** Bilinear sample of a relative DEM grid; null if missing / invalid. */
export function sampleDemHeight(p: Point, dem: DemGrid): number | null {
  if (dem.cols < 2 || dem.rows < 2 || dem.z.length < dem.cols * dem.rows) return null;
  const u = (p[0] - dem.x0) / dem.cell;
  const v = (p[1] - dem.y0) / dem.cell;
  const c0 = Math.max(0, Math.min(dem.cols - 2, Math.floor(u)));
  const r0 = Math.max(0, Math.min(dem.rows - 2, Math.floor(v)));
  const tx = Math.max(0, Math.min(1, u - c0));
  const ty = Math.max(0, Math.min(1, v - r0));
  const i = (c: number, r: number) => dem.z[r * dem.cols + c];
  const z00 = i(c0, r0);
  const z10 = i(c0 + 1, r0);
  const z01 = i(c0, r0 + 1);
  const z11 = i(c0 + 1, r0 + 1);
  if (![z00, z10, z01, z11].every((n) => Number.isFinite(n))) return null;
  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

/**
 * Vertical offset (m) at a model-frame point.
 * Prefers DEM samples when present; otherwise the mild street plane (streetward lower).
 */
export function gradeHeight(p: Point, grade: LotGrade | null | undefined): number {
  if (!grade) return 0;
  if (grade.dem) {
    const z = sampleDemHeight(p, grade.dem);
    if (z != null) return z;
  }
  if (grade.slope <= 0) return 0;
  const dx = p[0] - grade.origin[0];
  const dy = p[1] - grade.origin[1];
  return -(dx * grade.downhill[0] + dy * grade.downhill[1]) * grade.slope;
}

/** Min/max DEM heights (relative), for camera framing. */
export function demExtent(grade: LotGrade | null | undefined): { min: number; max: number } | null {
  const z = grade?.dem?.z;
  if (!z?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const n of z) {
    if (!Number.isFinite(n)) continue;
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  if (!Number.isFinite(min)) return null;
  return { min, max };
}

/**
 * Line-segment positions for a ground grid warped to lot grade / DEM.
 * Three.js coords: x east, y up, z = −modelY. Each cell edge is subdivided so hills read clearly.
 */
export function terrainGridLinePositions(
  grade: LotGrade | null | undefined,
  size: number,
  divisions: number,
  opts?: { yBias?: number; /** Samples per cell edge (≥1). */ subdivide?: number },
): Float32Array {
  const half = Math.max(8, size) / 2;
  const divs = Math.max(4, Math.min(64, Math.round(divisions)));
  const step = (half * 2) / divs;
  const sub = Math.max(1, Math.min(8, Math.round(opts?.subdivide ?? (grade?.dem ? 4 : 1))));
  const yBias = opts?.yBias ?? -0.12;
  const pts: number[] = [];
  const pushSeg = (mx0: number, my0: number, mx1: number, my1: number) => {
    for (let s = 0; s < sub; s++) {
      const t0 = s / sub;
      const t1 = (s + 1) / sub;
      const ax = mx0 + (mx1 - mx0) * t0;
      const ay = my0 + (my1 - my0) * t0;
      const bx = mx0 + (mx1 - mx0) * t1;
      const by = my0 + (my1 - my0) * t1;
      pts.push(ax, gradeHeight([ax, ay], grade) + yBias, -ay, bx, gradeHeight([bx, by], grade) + yBias, -by);
    }
  };
  for (let i = 0; i <= divs; i++) {
    const t = -half + i * step;
    for (let j = 0; j < divs; j++) {
      const a = -half + j * step;
      const b = a + step;
      // Lines of constant model-Y (run east–west).
      pushSeg(a, t, b, t);
      // Lines of constant model-X (run north–south).
      pushSeg(t, a, t, b);
    }
  }
  return Float32Array.from(pts);
}

/**
 * Triangle buffers for a DEM heightfield in Three.js coords (x east, y up, z = −modelY).
 * Each DEM sample becomes a vertex so outdoor relief reads as real topography, not a plane tilt.
 */
export function demHeightfieldBuffers(
  dem: DemGrid,
  opts?: { yBias?: number; /** Keep only cells whose center is within this model-frame radius. */ radiusM?: number },
): { positions: Float32Array; indices: Uint32Array } | null {
  if (dem.cols < 2 || dem.rows < 2 || dem.z.length < dem.cols * dem.rows) return null;
  const yBias = opts?.yBias ?? -0.05;
  const radius = opts?.radiusM;
  const r2 = radius != null && radius > 0 ? radius * radius : null;
  const n = dem.cols * dem.rows;
  const positions = new Float32Array(n * 3);
  const keep = new Uint8Array(n);
  for (let r = 0; r < dem.rows; r++) {
    for (let c = 0; c < dem.cols; c++) {
      const i = r * dem.cols + c;
      const mx = dem.x0 + c * dem.cell;
      const my = dem.y0 + r * dem.cell;
      const inside = r2 == null || mx * mx + my * my <= r2 * 1.02;
      keep[i] = inside ? 1 : 0;
      const h = dem.z[i];
      positions[i * 3] = mx;
      positions[i * 3 + 1] = (Number.isFinite(h) ? h : 0) + yBias;
      positions[i * 3 + 2] = -my;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < dem.rows - 1; r++) {
    for (let c = 0; c < dem.cols - 1; c++) {
      const i00 = r * dem.cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + dem.cols;
      const i11 = i01 + 1;
      if (!keep[i00] && !keep[i10] && !keep[i01] && !keep[i11]) continue;
      // Two triangles per cell; winding for upward normals with y-up / −modelY.
      idx.push(i00, i01, i10, i10, i01, i11);
    }
  }
  if (idx.length < 3) return null;
  return { positions, indices: Uint32Array.from(idx) };
}

/**
 * Porch / front-entry steps from street grade up to the house slab.
 * One feature per tread; `height` is the top surface Y (slab = 0 at the door).
 */
export function entryStairFeatures(opts: {
  streetDir: Point | null;
  grade: LotGrade | null;
  /** Front exit door midpoints in the model frame. */
  exits: Point[];
}): SiteFeature[] {
  const dir = opts.streetDir;
  if (!dir || opts.exits.length === 0) return [];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const downhill: Point = [dir[0] / len, dir[1] / len];
  const side: Point = [-downhill[1], downhill[0]];
  const out: SiteFeature[] = [];
  let flight = 0;
  for (const door of opts.exits) {
    // Sample ground a few treads toward the street — bottom of the run.
    const sample: Point = [door[0] + downhill[0] * 2.2, door[1] + downhill[1] * 2.2];
    const ground = gradeHeight(sample, opts.grade);
    // Top of stairs flush with the slab (y=0); always at least a short porch rise.
    const topY = 0.02;
    const bottomY = Math.min(topY - 0.4, ground - 0.05);
    const rise = topY - bottomY;
    const n = Math.max(2, Math.min(6, Math.round(rise / 0.17)));
    const riser = rise / n;
    const tread = 0.3;
    const halfW = 0.7;
    for (let i = 0; i < n; i++) {
      // i=0 is the bottom tread (furthest toward the street).
      const along = (n - i) * tread + 0.15;
      const c: Point = [door[0] + downhill[0] * along, door[1] + downhill[1] * along];
      const depth = tread * 0.92;
      const a: Point = [
        c[0] - downhill[0] * (depth / 2) + side[0] * halfW,
        c[1] - downhill[1] * (depth / 2) + side[1] * halfW,
      ];
      const b: Point = [
        c[0] + downhill[0] * (depth / 2) + side[0] * halfW,
        c[1] + downhill[1] * (depth / 2) + side[1] * halfW,
      ];
      const d: Point = [
        c[0] + downhill[0] * (depth / 2) - side[0] * halfW,
        c[1] + downhill[1] * (depth / 2) - side[1] * halfW,
      ];
      const e: Point = [
        c[0] - downhill[0] * (depth / 2) - side[0] * halfW,
        c[1] - downhill[1] * (depth / 2) - side[1] * halfW,
      ];
      out.push({
        id: `steps-${flight}-${i}`,
        kind: "steps",
        label: i === n - 1 ? "Entry stairs" : "Step",
        polygon: [a, b, d, e],
        // Absolute top Y of this tread (slab ≈ 0; lower treads are negative).
        height: bottomY + (i + 1) * riser,
        source: "estimated",
      });
    }
    flight++;
    if (flight >= 2) break;
  }
  return out;
}

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
function isNeighborCandidate(tag: string, area: number, _separationM: number): boolean {
  if (OUTBUILDING[tag]) return false;
  if (area < 35 || area > 4000) return false;
  if (isHouseLike(tag, area)) return true;
  // Untagged house-sized pads anywhere inside the neighbor radius.
  if ((tag === "yes" || !tag) && area >= 45) return true;
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

/** Cap drawn neighbor shells (nearest first) so a dense block does not flood the scene. */
export const MAX_NEIGHBOR_SHELLS = 36;
/** Cap drawn street ribbons (nearest first) after expanding road reach. */
export const MAX_ROAD_RIBBONS = 42;
/** Cap mapped + aerial trees kept around the site. */
export const MAX_TREE_MARKERS = 100;
/** Cap fire hydrants kept on the scene (nearest first). */
export const MAX_HYDRANTS = 60;
/** Cap traffic lights spawned at road crossings. */
export const MAX_TRAFFIC_SIGNALS = 10;

/** Floor / ceiling for the single outdoor scene radius (meters). */
export const SITE_REACH_MIN_M = 200;
export const SITE_REACH_MAX_M = 240;

/**
 * One outdoor radius for the warped grid, DEM, terrain disc, neighbors, roads,
 * hydrants, fences, trees, and OSM fetch. Everything that draws around the house
 * uses this so the scene edge matches.
 */
export function siteReach(mainRing: Point[]): number {
  const ext = foundationExtent(mainRing);
  return Math.min(SITE_REACH_MAX_M, Math.max(SITE_REACH_MIN_M, Math.round(ext * 3.5 + 40)));
}

/** Alias of siteReach — neighbors share the outdoor scene radius. */
export function neighborReach(mainRing: Point[]): number {
  return siteReach(mainRing);
}

/** Alias of siteReach — streets share the outdoor scene radius. */
export function roadReach(mainRing: Point[]): number {
  return siteReach(mainRing);
}

/** Distance used for neighbor radius: ring gap, falling back to centroid→foundation. */
export function neighborDistance(main: Point[] | null, mainC: Point, ring: Point[]): number {
  if (main && main.length >= 3 && ring.length >= 3) return ringSeparation(main, ring);
  return dist(ringCentroid(ring), mainC);
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

/**
 * Turn an aerial fence/hedge box (or ring) into thin ribbon segments along its long edges.
 * Short edges (< minLen) are skipped so driveway stubs don't become fences.
 */
export function fenceRibbonsFromPolygon(poly: Point[], opts?: { width?: number; minLen?: number }): Point[][] {
  if (poly.length < 2) return [];
  const width = opts?.width ?? 0.16;
  const minLen = opts?.minLen ?? 1.6;
  const closed =
    poly.length >= 3 &&
    Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 0.05
      ? poly.slice(0, -1)
      : poly;
  const out: Point[][] = [];
  const n = closed.length;
  for (let i = 0; i < n; i++) {
    const a = closed[i];
    const b = closed[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < minLen) continue;
    // For closed quads, keep the longer pair of edges (skip short ends).
    if (n === 4) {
      const lens = [0, 1, 2, 3].map((k) => {
        const p = closed[k];
        const q = closed[(k + 1) % 4];
        return Math.hypot(q[0] - p[0], q[1] - p[1]);
      });
      const long = Math.max(...lens);
      if (len < long * 0.72) continue;
    }
    const r = ribbon(a, b, width, 120);
    if (r) out.push(r);
  }
  return out;
}

/** Characteristic foundation size from the model origin (meters). */
export function foundationExtent(mainRing: Point[]): number {
  if (mainRing.length < 3) return 10;
  return Math.max(...mainRing.map(([x, y]) => Math.hypot(x, y)), 6);
}

/** Alias of siteReach — yard / aerial search share the outdoor scene radius. */
export function compoundReach(mainRing: Point[]): number {
  return siteReach(mainRing);
}

/**
 * How far a garage/shed may sit from the foundation edge (meters).
 * Kept tighter than siteReach so off-lot and far campus buildings are not drawn as "garages".
 */
export function accessoryReach(mainRing: Point[]): number {
  const ext = foundationExtent(mainRing);
  return Math.min(55, Math.max(18, ext * 1.2 + 10));
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
  const siteR = siteReach(site.mainRing);
  const reach = siteR;
  const accessoryR = accessoryReach(site.mainRing);
  const neighborR = siteR;
  const lotSoft = Math.min(6, Math.max(2.5, foundationExtent(site.mainRing) * 0.12));
  const maxOut = Math.max(120, Math.min(500, accessoryR * accessoryR * 0.12));
  const maxNeighborArea = Math.max(800, Math.min(4000, foundationExtent(site.mainRing) * foundationExtent(site.mainRing) * 4));
  const inScene = (p: Point) => dist(p, mainC) <= siteR;

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

  // Dwellings within neighborReach of the focus foundation — attached, next-door, across the street.
  const neighborHits = site.structures
    .filter((s) => {
      if (s.id === site.mainId || s.ring.length < 3) return false;
      if (s.area > maxNeighborArea) return false;
      const d = neighborDistance(main, mainC, s.ring);
      if (d > neighborR) return false;
      return isNeighborCandidate(s.tag, s.area, d);
    })
    .map((s) => ({
      s,
      d: neighborDistance(main, mainC, s.ring),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_NEIGHBOR_SHELLS);
  const neighborRings = neighborHits.map((h) => h.s.ring);
  const neighborSoft = Math.min(45, Math.max(18, accessoryR * 0.95));
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
    if (ring.length < 3 || !inScene(ringCentroid(ring))) return;
    features.push({ id: `pool-${i}`, kind: "pool", label: "Pool", polygon: ring, height: HEIGHT.pool, source: "map" });
  });

  (site.parking ?? []).forEach((ring, i) => {
    if (ring.length < 3 || !inScene(ringCentroid(ring))) return;
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
  const fenceCap = Math.min(240, Math.max(80, Math.round(siteR * 1.2)));
  for (const line of site.fences) {
    for (let i = 0; i < line.length - 1 && fenceCount < fenceCap; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inScene(mid)) continue;
      const polygon = ribbon(a, b, 0.14, Math.max(40, siteR * 0.65));
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
  const treeCap = MAX_TREE_MARKERS;
  for (const p of site.trees ?? []) {
    if (treeCount >= treeCap) break;
    if (!inScene(p)) continue;
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
    if (a.kind === "yard") continue;
    const c = ringCentroid(a.polygon);
    if (main && pointInRing(c, main)) continue;
    // Fences/trees fill the full scene disc; driveways/patios/outbuildings stay lot-local.
    if (a.kind === "fence" || a.kind === "trees") {
      if (!inScene(c)) continue;
    } else if (!nearNeighborhood(c)) {
      continue;
    }
    if (a.kind === "fence") {
      const ribbons = fenceRibbonsFromPolygon(a.polygon);
      const segs = ribbons.length ? ribbons : [a.polygon];
      for (const polygon of segs) {
        if (fenceCount >= fenceCap) break;
        const mid = ringCentroid(polygon);
        if (main && distToRing(mid, main) < 1.2) continue;
        // Skip near-duplicates of mapped fence segments.
        if (
          features.some(
            (f) => f.kind === "fence" && dist(ringCentroid(f.polygon), mid) < 2.2,
          )
        ) {
          continue;
        }
        features.push({
          id: `fence-aerial-${fenceCount}`,
          kind: "fence",
          label: a.label?.trim() || "Fence",
          polygon,
          height: HEIGHT.fence,
          source: "aerial",
        });
        fenceCount++;
      }
      continue;
    }
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

  // --- Backyard fill: mapped + aerial first; invent only when the rear lot is still empty. ---
  const yardRing = yard && yard.length >= 3 ? yard : null;
  const backFenceN = features.filter(
    (f) => f.kind === "fence" && inBackyard(ringCentroid(f.polygon), mainC, streetDir),
  ).length;
  const backTreeN = features.filter(
    (f) => f.kind === "trees" && inBackyard(ringCentroid(f.polygon), mainC, streetDir),
  ).length;

  // Soft parcel / hull perimeter when backyard barriers are still sparse.
  if (backFenceN < 3 && yardRing) {
    const ring = yardRing;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inBackyard(mid, mainC, streetDir)) continue;
      // Skip edges that hug the house (interior lot lines).
      if (main && distToRing(mid, main) < 1.5) continue;
      // Skip if a mapped/aerial fence already covers this edge.
      if (features.some((f) => f.kind === "fence" && dist(ringCentroid(f.polygon), mid) < 3.5)) continue;
      const polygon = ribbon(a, b, 0.14, Math.max(40, reach * 0.6));
      if (!polygon) continue;
      if (fenceCount >= fenceCap) break;
      features.push({
        id: `fence-est-${fenceCount}`,
        kind: "fence",
        label: hasParcel ? "Lot line fence" : "Fence",
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

  // Graded ground for the full neighbor render radius + pads under each building.
  features.unshift(...neighborhoodTerrainFeatures(main, neighborRings, siteR));

  return { features: features.slice(0, 360) };
}

/**
 * Cross-check mapped site features against aerial / satellite cues (Esri JPEG + Gemini boxes).
 * Keeps OSM when aerial agrees or is silent; drops map outbuildings contradicted by clear aerial
 * evidence; fills gaps from aerial when the map omitted them.
 * `geminiGarage` may also reflect Street View facade reading (merged upstream in the scan).
 */
export function crossVerifySiteFeatures(opts: {
  features: SiteFeature[];
  aerialCues: { kind: CompoundKind; label?: string; polygon: Point[]; confidence?: number }[];
  /** Gemini (+ Street View) house-level garage reading, when available. */
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

  // Add aerial cues the map missed (including fence / hedge ribbons).
  let addN = 0;
  for (const cue of cues) {
    if (cue.kind === "yard" || cue.kind === "road" || cue.kind === "signal" || cue.kind === "hydrant") continue;
    if ((cue.confidence ?? 0.5) < 0.4) continue;
    const c = ringCentroid(cue.polygon);
    if (cue.kind === "fence") {
      const ribbons = fenceRibbonsFromPolygon(cue.polygon);
      const segs = ribbons.length ? ribbons : [cue.polygon];
      for (const polygon of segs) {
        const mid = ringCentroid(polygon);
        if (filtered.some((f) => f.kind === "fence" && dist(ringCentroid(f.polygon), mid) < 2.5)) continue;
        filtered.push({
          id: `verify-aerial-${addN++}`,
          kind: "fence",
          label: cue.label?.trim() || LABEL.fence,
          polygon,
          height: HEIGHT.fence,
          source: "aerial",
        });
      }
      continue;
    }
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

  return filtered.slice(0, 220);
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
  const siteR = siteReach(opts.footprint);
  const keepR = siteR;
  const roadMax = Math.max(70, siteR * 0.95);
  const width = Math.min(12, Math.max(7.2, ringExtent(opts.footprint) * 0.15));
  const out: SiteFeature[] = [];

  // Hydrants share the same outdoor scene radius as streets / grid / neighbors.
  const nearestHydrants = [...(opts.hydrants ?? [])]
    .map((p) => ({ p, d: dist(here, p) }))
    .filter((h) => h.d < siteR)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_HYDRANTS);
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
  type RoadCand = { poly: Point[]; a: Point; b: Point; name: string | null; d: number };
  const segs: Seg[] = [];
  const roadCands: RoadCand[] = [];
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
      // Road runs after a wide clip can exceed the default ribbon max (~320 m).
      const poly = ribbon(runStart, b, width, Math.max(400, keepR * 2.2));
      const hit = nearestOn(here, runStart, b);
      if (poly && hit.d < keepR * 1.05) {
        roadCands.push({ poly, a: runStart, b, name: road.name, d: hit.d });
      }
      runStart = b;
    }
  }
  // Nearest ribbons first — cap count so a dense grid does not explode draw calls.
  roadCands
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_ROAD_RIBBONS)
    .forEach((r, roadIdx) => {
      out.push({
        id: `road-${roadIdx}`,
        kind: "road",
        label: r.name || "Street",
        polygon: r.poly,
        height: HEIGHT.road,
        source: "map",
      });
      segs.push({ a: r.a, b: r.b, name: r.name });
    });

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
      if (!hit || dist(hit, here) > keepR * 0.98) continue;
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
      if (signalN >= MAX_TRAFFIC_SIGNALS) break;
    }
    if (signalN >= MAX_TRAFFIC_SIGNALS) break;
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
