/**
 * Procedural roofs in the style of flight-sim / city-builder OSM buildings:
 * - Simple elongated rectangles → two-plane gable meeting on a ridge line
 * - Complex / concave / hip footprints → inward-offset loft (edge planes rising
 *   toward a medial ridge), the same idea as straight-skeleton hip roofs in games
 */
export type Pt = [number, number];

export type RoofWingMesh = {
  polygon: Pt[];
  ridge?: [Pt, Pt];
  height: number;
  shape: "gable" | "hip" | "flat";
};

export type RoofMeshSpec = {
  shape: "gable" | "hip" | "flat" | "gambrel" | "mansard" | "other";
  ridgeAlong: "width" | "depth";
  height: number;
  wings?: RoofWingMesh[];
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

function dist(a: Pt, b: Pt) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
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

function clean(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of poly) {
    const q: Pt = [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];
    const prev = out[out.length - 1];
    if (!prev || dist(q, prev) > 1e-3) out.push(q);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-3) out.pop();
  return out;
}

function densify(poly: Pt[], maxEdge: number): Pt[] {
  const ring = ccw(poly);
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const len = dist(a, b);
    const n = Math.max(1, Math.floor(len / maxEdge));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Arc-length resample so loft rings share a vertex count (game-engine style). */
export function resampleRing(poly: Pt[], n: number): Pt[] {
  const ring = ccw(poly);
  if (ring.length < 2 || n < 3) return ring;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = dist(ring[i], ring[(i + 1) % ring.length]);
    seg.push(d);
    total += d;
  }
  if (total < 1e-6) return ring;
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    let target = (k / n) * total;
    for (let i = 0; i < ring.length; i++) {
      if (target <= seg[i] + 1e-9) {
        const t = seg[i] < 1e-9 ? 0 : target / seg[i];
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      target -= seg[i];
    }
  }
  return out;
}

/**
 * Inward offset of a CCW ring (mitered). Same idea as CSG/city-builder roof generation:
 * each wall plane moves inward; miters form the valleys/hips.
 */
export function insetRing(poly: Pt[], amount: number): Pt[] | null {
  if (amount <= 1e-6) return ccw(poly);
  const ring = ccw(poly);
  if (ring.length < 3) return null;
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    const e1: Pt = [cur[0] - prev[0], cur[1] - prev[1]];
    const e2: Pt = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    // CCW: left normals point inward.
    const n1: Pt = [-e1[1] / l1, e1[0] / l1];
    const n2: Pt = [-e2[1] / l2, e2[0] / l2];
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const dot = Math.max(-0.92, Math.min(0.92, n1[0] * n2[0] + n1[1] * n2[1]));
    const miter = amount / Math.max(0.3, Math.sqrt((1 + dot) / 2));
    out.push([cur[0] + nx * miter, cur[1] + ny * miter]);
  }
  const cleaned = clean(ccw(out));
  if (cleaned.length < 3) return null;
  const a0 = Math.abs(signedArea(ring));
  const a1 = Math.abs(signedArea(cleaned));
  if (a1 < 0.35 || a1 >= a0 * 0.98) return null;
  // Reject self-flipped insets (area sign flip already handled by ccw; check centroid still inside).
  const c = cleaned.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Pt, [0, 0] as Pt);
  const mid: Pt = [c[0] / cleaned.length, c[1] / cleaned.length];
  if (!pointInRing(mid, ring)) return null;
  return cleaned;
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

function pushTri(out: number[], a: Pt, ha: number, b: Pt, hb: number, c: Pt, hc: number) {
  // Skip degenerates that cause z-fight / zero-area spikes.
  const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
  if (ab < 1e-4 || bc < 1e-4 || ca < 1e-4) return;
  out.push(a[0], ha, -a[1], b[0], hb, -b[1], c[0], hc, -c[1]);
}

function loftRings(rings: Pt[][], heights: number[], out: number[]) {
  const n = Math.max(12, Math.min(48, Math.round(rings[0].length * 2)));
  const sampled = rings.map((r) => resampleRing(r, n));
  for (let r = 0; r < sampled.length - 1; r++) {
    const a = sampled[r];
    const b = sampled[r + 1];
    const ha = heights[r];
    const hb = heights[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pushTri(out, a[i], ha, a[j], ha, b[i], hb);
      pushTri(out, a[j], ha, b[j], hb, b[i], hb);
    }
  }
  // Cap the top ring.
  const top = sampled[sampled.length - 1];
  const th = heights[heights.length - 1];
  const cx = top.reduce((s, p) => s + p[0], 0) / top.length;
  const cy = top.reduce((s, p) => s + p[1], 0) / top.length;
  const apex: Pt = [cx, cy];
  for (let i = 0; i < top.length; i++) {
    pushTri(out, top[i], th, top[(i + 1) % top.length], th, apex, th);
  }
}

function distToBoundary(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, nearestOnSeg(p, ring[i], ring[(i + 1) % ring.length]).d);
  }
  return best;
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Hip / complex roof (flight-sim / city-builder style):
 * 1) Try mitered inward-offset loft (smooth hips on convex footprints).
 * 2) Fall back to a boundary-distance height field on a subdivided triangulation —
 *    the usual game trick for L / stepped / irregular footprints (valleys form at
 *    re-entrants, ridges along the medial axis).
 */
export function meshOffsetRoof(poly: Pt[], height: number, out: number[], overhang = 0.25) {
  const eaves = overhang > 0 ? expandOut(ccw(poly), overhang) : ccw(poly);
  const h = Math.max(0.15, height);
  if (!isConcave(eaves)) {
    const rings: Pt[][] = [densify(eaves, 0.7)];
    const base = Math.sqrt(Math.abs(signedArea(eaves)));
    const step = Math.max(0.35, Math.min(1.1, base * 0.08));
    for (let i = 0; i < 10; i++) {
      const next = insetRing(rings[rings.length - 1], step);
      if (!next) break;
      rings.push(densify(next, Math.max(0.4, step)));
      if (Math.abs(signedArea(next)) < 1.2) break;
    }
    if (rings.length >= 2) {
      const heights = rings.map((_, i) => (i / (rings.length - 1)) * h);
      loftRings(rings, heights, out);
      return;
    }
  }
  meshDistanceRoof(eaves, h, out);
}

/** Height = pitch × distance-to-eaves; valleys appear naturally at concave corners. */
export function meshDistanceRoof(poly: Pt[], height: number, out: number[]) {
  const ring = densify(ccw(poly), 0.55);
  if (ring.length < 3) return;
  const faces = triangulate(ring);
  if (!faces.length) {
    meshFlat(poly, height, out);
    return;
  }
  let maxD = 0;
  for (const [i, j, k] of faces) {
    const c: Pt = [
      (ring[i][0] + ring[j][0] + ring[k][0]) / 3,
      (ring[i][1] + ring[j][1] + ring[k][1]) / 3,
    ];
    maxD = Math.max(maxD, distToBoundary(c, ring));
  }
  const pitch = height / Math.max(0.55, maxD);
  const hz = (p: Pt) => Math.min(height, distToBoundary(p, ring) * pitch);

  for (const [i, j, k] of faces) {
    const a = ring[i], b = ring[j], c = ring[k];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    // 4-way split gives a continuous ridge instead of a faceted fan.
    pushTri(out, a, hz(a), ab, hz(ab), ca, hz(ca));
    pushTri(out, b, hz(b), bc, hz(bc), ab, hz(ab));
    pushTri(out, c, hz(c), ca, hz(ca), bc, hz(bc));
    pushTri(out, ab, hz(ab), bc, hz(bc), ca, hz(ca));
  }
}

/** Outward miter for eaves overhang. */
function expandOut(poly: Pt[], amount: number): Pt[] {
  const ring = ccw(poly);
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    const e1: Pt = [cur[0] - prev[0], cur[1] - prev[1]];
    const e2: Pt = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    const o1: Pt = [e1[1] / l1, -e1[0] / l1];
    const o2: Pt = [e2[1] / l2, -e2[0] / l2];
    let ox = o1[0] + o2[0];
    let oy = o1[1] + o2[1];
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol;
    oy /= ol;
    const dot = Math.max(-0.92, Math.min(0.92, o1[0] * o2[0] + o1[1] * o2[1]));
    const miter = amount / Math.max(0.3, Math.sqrt((1 + dot) / 2));
    out.push([cur[0] + ox * miter, cur[1] + oy * miter]);
  }
  return clean(ccw(out));
}

function nearestOnSeg(p: Pt, a: Pt, b: Pt): { at: Pt; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const at: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { at, d: dist(p, at) };
}

function onSeg(p: Pt, a: Pt, b: Pt, tol = 0.18): boolean {
  return nearestOnSeg(p, a, b).d < tol;
}

function clipHalf(poly: Pt[], inside: (p: Pt) => boolean, hit: (a: Pt, b: Pt) => Pt): Pt[] {
  if (!poly.length) return [];
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain && bin) out.push(b);
    else if (ain && !bin) out.push(hit(a, b));
    else if (!ain && bin) {
      out.push(hit(a, b));
      out.push(b);
    }
  }
  return clean(out);
}

export function splitByRidge(poly: Pt[], a: Pt, b: Pt): { left: Pt[]; right: Pt[] } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const side = (p: Pt) => dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
  const hit = (p: Pt, q: Pt): Pt => {
    const sp = side(p), sq = side(q);
    const t = sp / (sp - sq || 1e-12);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  return {
    left: ccw(clipHalf(poly, (p) => side(p) >= -1e-6, hit)),
    right: ccw(clipHalf(poly, (p) => side(p) <= 1e-6, hit)),
  };
}

/** Classic two-plane gable for near-rectangular wings (ridge line). */
function meshGable(poly: Pt[], ridge: [Pt, Pt], h: number, out: number[]) {
  const plate = densify(expandOut(poly, 0.2), 0.5);
  const { left, right } = splitByRidge(plate, ridge[0], ridge[1]);
  for (const half of [left, right]) {
    if (half.length < 3) continue;
    const dense = densify(half, 0.5);
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i];
      const b = dense[(i + 1) % dense.length];
      if (onSeg(a, ridge[0], ridge[1]) && onSeg(b, ridge[0], ridge[1])) continue;
      const na = nearestOnSeg(a, ridge[0], ridge[1]).at;
      const nb = nearestOnSeg(b, ridge[0], ridge[1]).at;
      const ha = onSeg(a, ridge[0], ridge[1]) ? h : 0;
      const hb = onSeg(b, ridge[0], ridge[1]) ? h : 0;
      if (dist(na, nb) < 0.15) pushTri(out, a, ha, b, hb, na, h);
      else {
        pushTri(out, a, ha, b, hb, na, h);
        pushTri(out, b, hb, nb, h, na, h);
      }
    }
  }
}

function meshFlat(poly: Pt[], h: number, out: number[]) {
  const eaves = expandOut(ccw(poly), 0.12);
  const dense = densify(eaves, 0.9);
  const c = dense.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Pt, [0, 0] as Pt);
  const apex: Pt = [c[0] / dense.length, c[1] / dense.length];
  const zh = Math.max(0.12, h * 0.35);
  for (let i = 0; i < dense.length; i++) {
    pushTri(out, dense[i], zh, dense[(i + 1) % dense.length], zh, apex, zh);
  }
}

function aspectOf(poly: Pt[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const w = maxX - minX;
  const d = maxY - minY;
  return Math.max(w, d) / Math.max(0.5, Math.min(w, d));
}

function meshWing(wing: RoofWingMesh, out: number[]) {
  if (wing.polygon.length < 3 || Math.abs(signedArea(wing.polygon)) < 0.2) return;
  const h = Math.max(0.12, wing.height);
  if (wing.shape === "flat") {
    meshFlat(wing.polygon, h, out);
    return;
  }
  // Flight-sim / city-builder style: irregular footprints get inward-offset loft
  // hips (edge planes → medial ridge). Only clean convex bars keep a two-plane gable.
  if (wing.shape === "hip" || !wing.ridge || isConcave(wing.polygon) || aspectOf(wing.polygon) < 1.28) {
    meshOffsetRoof(wing.polygon, h, out);
    return;
  }
  meshGable(wing.polygon, wing.ridge, h, out);
}

function fallbackWings(poly: Pt[], spec: RoofMeshSpec): RoofWingMesh[] {
  const ring = ccw(poly);
  if (spec.shape === "flat") return [{ polygon: ring, height: spec.height, shape: "flat" }];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let cx = 0, cy = 0;
  for (const p of ring) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    cx += p[0]; cy += p[1];
  }
  cx /= ring.length;
  cy /= ring.length;
  const ridge: [Pt, Pt] =
    spec.ridgeAlong === "width"
      ? [[minX + 0.2, cy], [maxX - 0.2, cy]]
      : [[cx, minY + 0.2], [cx, maxY - 0.2]];
  const shape = spec.shape === "hip" || spec.shape === "other" ? "hip" : "gable";
  return [{ polygon: ring, ridge, height: spec.height, shape }];
}

export function buildRoofPositions(planPoly: Pt[], spec: RoofMeshSpec): number[] {
  const wings = spec.wings?.length ? spec.wings : fallbackWings(planPoly, spec);
  const out: number[] = [];
  for (const wing of wings) meshWing(wing, out);
  return out;
}

/** Kept for tests / callers that need a flat triangulation. */
export function triangulate(ringIn: Pt[]): number[][] {
  const ring = ccw(ringIn);
  if (ring.length < 3) return [];
  const n0 = ring.length;
  const idx = Array.from({ length: n0 }, (_, i) => i);
  const area = signedArea(ring);
  const faces: number[][] = [];
  let guard = 0;
  const inTri = (p: Pt, a: Pt, b: Pt, c: Pt) => {
    const sign = (p1: Pt, p2: Pt, p3: Pt) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const b1 = sign(p, a, b) < 0;
    const b2 = sign(p, b, c) < 0;
    const b3 = sign(p, c, a) < 0;
    return b1 === b2 && b2 === b3;
  };
  while (idx.length > 3 && guard++ < n0 * n0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = ring[i0], b = ring[i1], c = ring[i2];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area > 0 ? cross <= 1e-9 : cross >= -1e-9) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTri(ring[j], a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      faces.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) faces.push([idx[0], idx[1], idx[2]]);
  return faces;
}
