/**
 * Infer a ridge-line / multi-wing roof plan from the footprint, OSM tags, aerial cues, and optional Gemini.
 * No center-point cone: every pitched wing has a ridge segment.
 */
export type Pt = [number, number];

export type RoofShapeName = "gable" | "hip" | "flat" | "gambrel" | "mansard" | "other";

export type RoofWingPlan = {
  polygon: Pt[];
  ridge?: [Pt, Pt];
  height: number;
  shape: "gable" | "hip" | "flat";
};

export type RoofPlanOut = {
  kind: "flat" | "gable" | "hip" | "wings";
  wings: RoofWingPlan[];
  source: string;
  shape: RoofShapeName;
  ridgeAlong: "width" | "depth";
};

export type AerialCue = {
  shape: "gable" | "hip" | "flat" | null;
  ridgeBearingDeg: number | null;
  confidence: number;
  note: string;
};

export type GeminiRoof = {
  roof_shape: RoofShapeName;
  ridge_along: "front_to_back" | "side_to_side" | "unknown";
};

const OSM_ROOF: Record<string, RoofShapeName> = {
  gabled: "gable",
  "half-hipped": "hip",
  hipped: "hip",
  pyramidal: "hip",
  flat: "flat",
  skillion: "flat",
  gambrel: "gambrel",
  mansard: "mansard",
  saltbox: "gable",
  dome: "other",
  round: "other",
};

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function ccw(poly: Pt[]): Pt[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function isConcave(poly: Pt[]): boolean {
  const ring = ccw(poly);
  if (ring.length < 4) return false;
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

function polygonArea(poly: Pt[]): number {
  return Math.abs(signedArea(poly));
}

function minAreaRect(ring: Pt[]) {
  let best: { u: Pt; v: Pt; wU: number; wV: number; center: Pt; area: number; minU: number; maxU: number; minV: number; maxV: number } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.1) continue;
    const u: Pt = [(x2 - x1) / len, (y2 - y1) / len];
    const v: Pt = [-u[1], u[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of ring) {
      const pu = x * u[0] + y * u[1];
      const pv = x * v[0] + y * v[1];
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const mu = (minU + maxU) / 2, mv = (minV + maxV) / 2;
      best = {
        u, v, wU: maxU - minU, wV: maxV - minV, area, minU, maxU, minV, maxV,
        center: [mu * u[0] + mv * v[0], mu * u[1] + mv * v[1]],
      };
    }
  }
  if (!best) throw new Error("degenerate polygon");
  return best;
}

export type FootClass = "elongated" | "square" | "L" | "flat_pad" | "complex";

export function classifyFootprint(poly: Pt[]): { kind: FootClass; aspect: number; area: number; longAlongU: boolean } {
  const area = polygonArea(poly);
  if (area > 350) return { kind: "flat_pad", aspect: 1, area, longAlongU: true };
  const rect = minAreaRect(poly);
  const longAlongU = rect.wU >= rect.wV;
  const aspect = Math.max(rect.wU, rect.wV) / Math.max(0.5, Math.min(rect.wU, rect.wV));
  const concave = isConcave(poly);
  if (!concave && aspect < 1.25) return { kind: "square", aspect, area, longAlongU };
  if (!concave && aspect >= 1.25) return { kind: "elongated", aspect, area, longAlongU };
  // Concave: a real L is chunky (aspect not extreme). A long bar with a small step stays elongated.
  if (concave) {
    const arms = measureArms(poly, rect);
    if (arms >= 2 && aspect < 1.85) return { kind: "L", aspect, area, longAlongU };
    if (aspect >= 1.25) return { kind: "elongated", aspect, area, longAlongU };
    return { kind: "complex", aspect, area, longAlongU };
  }
  return { kind: "complex", aspect, area, longAlongU };
}

/** Count roughly independent filled slabs in OBB space (1 = jog, 2 = real L). */
function measureArms(poly: Pt[], rect: ReturnType<typeof minAreaRect>): number {
  const bins = 12;
  const fillU = new Array(bins).fill(0);
  const fillV = new Array(bins).fill(0);
  for (const [x, y] of poly) {
    const pu = x * rect.u[0] + y * rect.u[1];
    const pv = x * rect.v[0] + y * rect.v[1];
    const iu = Math.min(bins - 1, Math.max(0, Math.floor(((pu - rect.minU) / (rect.wU || 1)) * bins)));
    const iv = Math.min(bins - 1, Math.max(0, Math.floor(((pv - rect.minV) / (rect.wV || 1)) * bins)));
    fillU[iu]++;
    fillV[iv]++;
  }
  const runs = (fill: number[]) => {
    let n = 0;
    let on = false;
    for (const v of fill) {
      if (v > 0 && !on) {
        n++;
        on = true;
      } else if (v === 0) on = false;
    }
    return n;
  };
  return Math.max(runs(fillU), runs(fillV));
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function clipSegToPoly(a: Pt, b: Pt, poly: Pt[]): [Pt, Pt] | null {
  // Sample the segment and keep the inside span.
  const hits: { t: number; p: Pt }[] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (pointInRing(p, poly) || distToRing(p, poly) < 0.05) hits.push({ t, p });
  }
  if (hits.length < 2) return null;
  return [hits[0].p, hits[hits.length - 1].p];
}

function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

function ridgeOnObb(poly: Pt[], alongLong: boolean, inset = 0.15): [Pt, Pt] | null {
  const rect = minAreaRect(poly);
  const longIsU = rect.wU >= rect.wV;
  const useU = alongLong ? longIsU : !longIsU;
  const axis = useU ? rect.u : rect.v;
  const half = (useU ? rect.wU : rect.wV) / 2;
  const trim = Math.min(half * inset, half - 0.2);
  const a: Pt = [rect.center[0] - axis[0] * (half - trim), rect.center[1] - axis[1] * (half - trim)];
  const b: Pt = [rect.center[0] + axis[0] * (half - trim), rect.center[1] + axis[1] * (half - trim)];
  return clipSegToPoly(a, b, poly) ?? [a, b];
}

function rise(shape: RoofShapeName, span: number): number {
  const s = Math.max(3, span);
  if (shape === "flat") return 0.4;
  if (shape === "hip") return Math.min(3.4, Math.max(1.4, s * 0.28));
  if (shape === "gambrel") return Math.min(4.2, Math.max(2, s * 0.38));
  if (shape === "mansard") return 2.4;
  return Math.min(4, Math.max(1.6, s * 0.33));
}

/** Split an L at the strongest reflex corner with an inward cut. */
export function splitLWings(poly: Pt[]): Pt[][] {
  const ring = ccw(poly);
  const n = ring.length;
  let bestI = -1;
  let bestCross = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    // CCW: reflex = right turn = negative cross.
    if (cross < bestCross) {
      bestCross = cross;
      bestI = i;
    }
  }
  if (bestI < 0) return [ring];

  const a = ring[(bestI - 1 + n) % n];
  const b = ring[bestI];
  const c = ring[(bestI + 1) % n];
  const e1: Pt = [a[0] - b[0], a[1] - b[1]];
  const e2: Pt = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(e1[0], e1[1]) || 1;
  const l2 = Math.hypot(e2[0], e2[1]) || 1;
  let ix = e1[0] / l1 + e2[0] / l2;
  let iy = e1[1] / l1 + e2[1] / l2;
  const il = Math.hypot(ix, iy) || 1;
  ix /= il;
  iy /= il;
  // Bisector of the two edge directions points into the missing corner on an L; flip into the solid.
  const probe: Pt = [b[0] + ix * 0.4, b[1] + iy * 0.4];
  if (!pointInRing(probe, ring)) {
    ix = -ix;
    iy = -iy;
  }
  // Ray from b inward; find farthest intersection with another edge.
  let hit: Pt | null = null;
  let hitDist = 0;
  let hitEdge = -1;
  for (let j = 0; j < n; j++) {
    if (j === bestI || (j + 1) % n === bestI || j === (bestI - 1 + n) % n) continue;
    const p = ring[j];
    const q = ring[(j + 1) % n];
    const inter = raySegHit(b, [ix, iy], p, q);
    if (!inter) continue;
    const d = Math.hypot(inter[0] - b[0], inter[1] - b[1]);
    if (d > hitDist && d > 0.5) {
      hitDist = d;
      hit = inter;
      hitEdge = j;
    }
  }
  if (!hit || hitEdge < 0) return [ring];

  const wingA: Pt[] = [b, hit];
  for (let k = (hitEdge + 1) % n; k !== bestI; k = (k + 1) % n) wingA.push(ring[k]);
  const wingB: Pt[] = [b];
  for (let k = (bestI + 1) % n; k !== (hitEdge + 1) % n; k = (k + 1) % n) wingB.push(ring[k]);
  wingB.push(hit);

  const parts = [ccw(wingA), ccw(wingB)].filter((p) => p.length >= 3 && polygonArea(p) > 4);
  return parts.length >= 2 ? parts : [ring];
}

function raySegHit(o: Pt, d: Pt, a: Pt, b: Pt): Pt | null {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const det = d[0] * ry - d[1] * rx;
  if (Math.abs(det) < 1e-9) return null;
  const qx = a[0] - o[0], qy = a[1] - o[1];
  const t = (qx * ry - qy * rx) / det;
  const u = (qx * d[1] - qy * d[0]) / det;
  if (t < 0.05 || u < 0 || u > 1) return null;
  return [o[0] + d[0] * t, o[1] + d[1] * t];
}

/** Snap a volume to its min-area rectangle (clean eaves, no diagonal stretch). */
export function snapToObbRect(poly: Pt[]): Pt[] {
  const r = minAreaRect(poly);
  const hu = r.wU / 2,
    hv = r.wV / 2;
  const corners: Pt[] = [
    [r.center[0] - r.u[0] * hu - r.v[0] * hv, r.center[1] - r.u[1] * hu - r.v[1] * hv],
    [r.center[0] + r.u[0] * hu - r.v[0] * hv, r.center[1] + r.u[1] * hu - r.v[1] * hv],
    [r.center[0] + r.u[0] * hu + r.v[0] * hv, r.center[1] + r.u[1] * hu + r.v[1] * hv],
    [r.center[0] - r.u[0] * hu + r.v[0] * hv, r.center[1] - r.u[1] * hu + r.v[1] * hv],
  ];
  return ccw(corners);
}

function nearlyRect(poly: Pt[]): boolean {
  if (isConcave(poly)) return false;
  const r = minAreaRect(poly);
  const cover = polygonArea(poly) / Math.max(0.1, r.wU * r.wV);
  return cover > 0.82 && poly.length <= 6;
}

/**
 * Largest filled axis-aligned block in a binary occupancy grid (histogram method).
 */
function largestGridRect(fill: boolean[][]): { r0: number; r1: number; c0: number; c1: number; area: number } | null {
  const rows = fill.length;
  const cols = fill[0]?.length ?? 0;
  if (!rows || !cols) return null;
  const height = new Array(cols).fill(0);
  let best: { r0: number; r1: number; c0: number; c1: number; area: number } | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) height[c] = fill[r][c] ? height[c] + 1 : 0;
    const stack: number[] = [];
    const pushRect = (left: number, right: number, h: number, bottom: number) => {
      if (h <= 0 || right <= left) return;
      const area = h * (right - left);
      if (!best || area > best.area) {
        best = { r0: bottom - h + 1, r1: bottom + 1, c0: left, c1: right, area };
      }
    };
    for (let c = 0; c <= cols; c++) {
      const h = c < cols ? height[c] : 0;
      while (stack.length && height[stack[stack.length - 1]] > h) {
        const ti = stack.pop()!;
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        pushRect(left, c, height[ti], r);
      }
      stack.push(c);
    }
  }
  return best;
}

/**
 * Break an irregular footprint into rectangle volumes via OBB occupancy.
 * Main trunk = largest rectangle; remaining filled cells become wings.
 */
export function extractRectVolumes(poly: Pt[], maxParts = 4): Pt[][] {
  const ring = ccw(poly);
  const obb = minAreaRect(ring);
  const n = 28;
  const fill: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
  let filled = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u = obb.minU + ((i + 0.5) / n) * obb.wU;
      const v = obb.minV + ((j + 0.5) / n) * obb.wV;
      const p: Pt = [u * obb.u[0] + v * obb.v[0], u * obb.u[1] + v * obb.v[1]];
      if (pointInRing(p, ring)) {
        fill[i][j] = true;
        filled++;
      }
    }
  }
  if (filled < 4) return [snapToObbRect(ring)];

  const parts: Pt[][] = [];
  const cellA = (obb.wU / n) * (obb.wV / n);
  const minCells = Math.max(4, Math.floor(filled * 0.08));

  for (let iter = 0; iter < maxParts; iter++) {
    const block = largestGridRect(fill);
    if (!block || block.area < minCells) break;
    const u0 = obb.minU + (block.r0 / n) * obb.wU;
    const u1 = obb.minU + (block.r1 / n) * obb.wU;
    const v0 = obb.minV + (block.c0 / n) * obb.wV;
    const v1 = obb.minV + (block.c1 / n) * obb.wV;
    const hu = (u1 - u0) / 2,
      hv = (v1 - v0) / 2;
    const cu = (u0 + u1) / 2,
      cv = (v0 + v1) / 2;
    const center: Pt = [cu * obb.u[0] + cv * obb.v[0], cu * obb.u[1] + cv * obb.v[1]];
    const corners: Pt[] = [
      [center[0] - obb.u[0] * hu - obb.v[0] * hv, center[1] - obb.u[1] * hu - obb.v[1] * hv],
      [center[0] + obb.u[0] * hu - obb.v[0] * hv, center[1] + obb.u[1] * hu - obb.v[1] * hv],
      [center[0] + obb.u[0] * hu + obb.v[0] * hv, center[1] + obb.u[1] * hu + obb.v[1] * hv],
      [center[0] - obb.u[0] * hu + obb.v[0] * hv, center[1] - obb.u[1] * hu + obb.v[1] * hv],
    ];
    parts.push(ccw(corners));
    for (let i = block.r0; i < block.r1; i++) {
      for (let j = block.c0; j < block.c1; j++) fill[i][j] = false;
    }
  }
  return parts.length ? parts : [snapToObbRect(ring)];
}

/**
 * Irregular footprints → simple rectangle volumes (main trunk + wings).
 * Never stretch one roof over concave / diagonal weirdness.
 */
export function decomposeRoofVolumes(poly: Pt[]): Pt[][] {
  const ring = ccw(poly);
  if (!isConcave(ring)) {
    return [nearlyRect(ring) ? snapToObbRect(ring) : ring];
  }

  // Inside-corner L / T: split at the strongest reflex, recurse once for U-shapes.
  let parts = splitLWings(ring);
  if (parts.length >= 2) {
    const expanded: Pt[][] = [];
    for (const p of parts) {
      if (isConcave(p) && classifyFootprint(p).kind === "L") {
        const sub = splitLWings(p);
        if (sub.length >= 2) expanded.push(...sub);
        else expanded.push(p);
      } else {
        expanded.push(p);
      }
    }
    const cleaned = expanded
      .filter((p) => polygonArea(p) > 4)
      .map((p) => (nearlyRect(p) || !isConcave(p) ? snapToObbRect(p) : p));
    if (cleaned.length >= 2) return cleaned.slice(0, 4);
  }

  // Weird diagonals / complex concave: maximal rectangles in OBB space.
  return extractRectVolumes(ring, 4);
}

function wingFromPoly(poly: Pt[], shape: "gable" | "hip" | "flat", alongLong: boolean): RoofWingPlan {
  const rect = minAreaRect(poly);
  const span = Math.min(rect.wU, rect.wV);
  const height = rise(shape === "flat" ? "flat" : shape, span);
  if (shape === "flat") return { polygon: ccw(poly), height, shape: "flat" };
  const ridge = ridgeOnObb(poly, shape === "hip" ? true : alongLong, shape === "hip" ? 0.28 : 0.08);
  return { polygon: ccw(poly), ridge: ridge ?? undefined, height, shape };
}

function longSpan(poly: Pt[]): number {
  const r = minAreaRect(poly);
  return Math.max(r.wU, r.wV);
}

function shortSpan(poly: Pt[]): number {
  const r = minAreaRect(poly);
  return Math.min(r.wU, r.wV);
}

/**
 * Main trunk first (tallest ridge), then wings at the same pitch with lower ridges.
 * Each wing keeps a FULL ridge over its own rectangle — overlapping prisms at the
 * L/T join look clean; clipping ridges mid-wing was twisting the mesh.
 */
export function joinMainAndWings(parts: Pt[][]): RoofWingPlan[] {
  const ranked = [...parts].sort((a, b) => polygonArea(b) - polygonArea(a) || longSpan(b) - longSpan(a));
  if (!ranked.length) return [];

  // Keep the real wing outline when it's already a clean convex volume; only
  // snap messy leftovers so the roof follows the walls instead of a fat OBB.
  const asVolume = (p: Pt[]) => (nearlyRect(p) || (!isConcave(p) && p.length <= 6) ? ccw(p) : snapToObbRect(p));
  const mainPoly = asVolume(ranked[0]);
  const mainSpan = shortSpan(mainPoly);
  const mainHeight = Math.max(1.6, rise("gable", mainSpan));
  const pitch = mainHeight / Math.max(0.5, mainSpan / 2); // rise / run

  const primary = wingFromPoly(mainPoly, "gable", true);
  primary.shape = "gable";
  primary.height = mainHeight;

  const out: RoofWingPlan[] = [primary];

  for (const raw of ranked.slice(1)) {
    const poly = asVolume(raw);
    const span = shortSpan(poly);
    const aspect = longSpan(poly) / Math.max(0.5, span);
    // Narrower wings → lower ridge at the same pitch (water still drains outward).
    const height = Math.min(mainHeight * 0.92, Math.max(0.9, pitch * (span / 2)));
    const wing = wingFromPoly(poly, aspect < 1.15 ? "hip" : "gable", true);
    wing.height = height;
    wing.shape = aspect < 1.15 ? "hip" : "gable";
    out.push(wing);
  }
  return out;
}

/** @deprecated alias — L/T/U all go through joinMainAndWings */
export function joinIntersectingLWings(parts: Pt[][]): RoofWingPlan[] {
  return joinMainAndWings(parts);
}

function bearingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/**
 * Fuse OSM, aerial, Gemini, and footprint into a concrete roof plan in the model frame.
 * `streetAlongDepth` means plan depth (front-to-back) should be the default gable ridge for "along".
 */
export function inferRoofPlan(opts: {
  footprint: Pt[];
  osmTags?: Record<string, string>;
  aerial?: AerialCue | null;
  gemini?: GeminiRoof | null;
  /** Unit vector of plan +y in model frame (backyard direction), for mapping aerial bearings. */
  planYAxis?: Pt;
}): RoofPlanOut {
  const poly = ccw(opts.footprint);
  const foot = classifyFootprint(poly);
  const tags = opts.osmTags ?? {};
  const osmRaw = tags["roof:shape"] || tags["building:roof:shape"];
  const osmShape = osmRaw && OSM_ROOF[osmRaw] ? OSM_ROOF[osmRaw] : null;
  const osmOrient = (tags["roof:orientation"] || "").toLowerCase();

  let shape: RoofShapeName = "gable";
  let source = "footprint";
  if (osmShape) {
    shape = osmShape;
    source = "map";
  } else if (opts.gemini?.roof_shape) {
    shape = opts.gemini.roof_shape;
    source = "photos";
  } else if (opts.aerial?.shape && (opts.aerial.confidence ?? 0) >= 0.35) {
    // Aerial hip cues on a long bar are usually shading, not a true hip.
    if (opts.aerial.shape === "hip" && foot.kind === "elongated") {
      shape = "gable";
      source = "aerial";
    } else {
      shape = opts.aerial.shape;
      source = "aerial";
    }
  } else if (foot.kind === "flat_pad") {
    shape = "flat";
    source = "footprint";
  } else if (foot.kind === "square") {
    shape = "hip";
    source = "footprint";
  } else {
    shape = "gable";
    source = "footprint";
  }

  // Ridge along the longer footprint axis by default; OSM/Gemini/aerial can flip it.
  let alongLong = true;
  let ridgeAlong: "width" | "depth" = foot.longAlongU ? "depth" : "width";
  // In buildHouse, depth is front-back. longAlongU depends on OBB of model-frame footprint.
  // Map aerial bearing onto the OBB long axis when confident.
  if (osmOrient === "along") alongLong = true;
  else if (osmOrient === "across") alongLong = false;
  else if (opts.gemini?.ridge_along === "front_to_back") {
    // Prefer ridge along depth = front-to-back in plan; treat as alongLong if depth is longer.
    alongLong = foot.longAlongU; // keep long unless we know axes — layout remaps ridgeAlong
    ridgeAlong = "depth";
  } else if (opts.gemini?.ridge_along === "side_to_side") {
    alongLong = !foot.longAlongU;
    ridgeAlong = "width";
  } else if (opts.aerial?.ridgeBearingDeg != null && opts.planYAxis && opts.aerial.confidence >= 0.35) {
    const rect = minAreaRect(poly);
    const longAxis = rect.wU >= rect.wV ? rect.u : rect.v;
    // Bearing of long axis: east=x, north=y → atan2(east, north).
    let longBear = (Math.atan2(longAxis[0], longAxis[1]) * 180) / Math.PI;
    if (longBear < 0) longBear += 360;
    const alignLong = bearingDiff(opts.aerial.ridgeBearingDeg, longBear) < 35;
    alongLong = alignLong;
  }

  if (osmOrient === "along") ridgeAlong = "depth";
  if (osmOrient === "across") ridgeAlong = "width";

  const meshShape: "gable" | "hip" | "flat" =
    shape === "flat" ? "flat" : shape === "hip" || shape === "other" ? "hip" : "gable";

  if (meshShape === "flat" || foot.kind === "flat_pad") {
    // Concave / multi-wing pads: one flat per rectangle volume so courtyards stay open.
    if (isConcave(poly) || foot.kind === "complex" || foot.kind === "L") {
      const parts = decomposeRoofVolumes(poly);
      if (parts.length >= 2) {
        const wings = parts.map((p) => {
          const vol = nearlyRect(p) || (!isConcave(p) && p.length <= 6) ? ccw(p) : snapToObbRect(p);
          return wingFromPoly(vol, "flat", true);
        });
        return { kind: "wings", wings, source, shape: "flat", ridgeAlong };
      }
    }
    const w = wingFromPoly(poly, "flat", true);
    return { kind: "flat", wings: [w], source, shape, ridgeAlong };
  }

  // Irregular / L / U / complex: never stretch one roof — main trunk + wings.
  // Concave elongated bars (small jogs) keep one gable; only L/complex get split.
  if (foot.kind === "L" || foot.kind === "complex") {
    const parts = decomposeRoofVolumes(poly);
    if (parts.length >= 2) {
      const wings = joinMainAndWings(parts);
      return {
        kind: "wings",
        wings,
        source: source === "footprint" ? "footprint" : source,
        shape: "gable",
        ridgeAlong,
      };
    }
  }

  // True square hip only when asked for hip, or a compact convex pad.
  if (meshShape === "hip" || foot.kind === "square") {
    const w = wingFromPoly(nearlyRect(poly) ? snapToObbRect(poly) : poly, "hip", true);
    return { kind: "hip", wings: [w], source, shape: "hip", ridgeAlong };
  }

  // Elongated / stepped: one clean gable (snap to OBB when nearly rectangular).
  const body = nearlyRect(poly) ? snapToObbRect(poly) : poly;
  const w = wingFromPoly(body, "gable", alongLong);
  const rect = minAreaRect(body);
  const long = rect.wU >= rect.wV ? rect.u : rect.v;
  const alongWidth = Math.abs(long[0]) >= Math.abs(long[1]);
  if (!opts.gemini?.ridge_along || opts.gemini.ridge_along === "unknown") {
    if (alongLong) ridgeAlong = alongWidth ? "width" : "depth";
    else ridgeAlong = alongWidth ? "depth" : "width";
  }
  return { kind: "gable", wings: [w], source, shape, ridgeAlong };
}
