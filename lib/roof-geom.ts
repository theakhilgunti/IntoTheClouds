/**
 * Bloxburg-style roofs from wall vertices & edges.
 *
 * One roof piece per closed wall ring:
 *  - hip  → one trapezoid per eave edge → matching inset ridge verts (same count)
 *  - gable → two slopes from long eaves to a ridge between short-wall midpoints
 *  - flat → opaque deck on the eaves polygon
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

/** True wall corners only — Bloxburg roofs sit on vertices, not densified edges. */
export function simplifyRing(poly: Pt[], eps = 0.05): Pt[] {
  const ring = ccw(poly);
  if (ring.length < 3) return ring;
  const dedup: Pt[] = [];
  for (const p of ring) {
    const prev = dedup[dedup.length - 1];
    if (!prev || dist(p, prev) > eps) dedup.push([p[0], p[1]]);
  }
  if (dedup.length > 1 && dist(dedup[0], dedup[dedup.length - 1]) <= eps) dedup.pop();

  const out: Pt[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = dedup[(i - 1 + dedup.length) % dedup.length];
    const cur = dedup[i];
    const next = dedup[(i + 1) % dedup.length];
    const e1: Pt = [cur[0] - prev[0], cur[1] - prev[1]];
    const e2: Pt = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    const cross = (e1[0] / l1) * (e2[1] / l2) - (e1[1] / l1) * (e2[0] / l2);
    if (Math.abs(cross) < 0.025 && dist(prev, next) > eps) continue;
    out.push(cur);
  }
  return out.length >= 3 ? ccw(out) : dedup.length >= 3 ? dedup : ring;
}

function pushTri(out: number[], a: Pt, ha: number, b: Pt, hb: number, c: Pt, hc: number) {
  if (dist(a, b) < 1e-5 || dist(b, c) < 1e-5 || dist(c, a) < 1e-5) return;
  out.push(a[0], ha, -a[1], b[0], hb, -b[1], c[0], hc, -c[1]);
}

function pushQuad(out: number[], a: Pt, ha: number, b: Pt, hb: number, c: Pt, hc: number, d: Pt, hd: number) {
  pushTri(out, a, ha, b, hb, c, hc);
  pushTri(out, a, ha, c, hc, d, hd);
}

function expandOut(poly: Pt[], amount: number): Pt[] {
  const ring = ccw(poly);
  if (amount <= 0) return [...ring];
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
    const miter = amount / Math.max(0.35, Math.sqrt((1 + dot) / 2));
    out.push([cur[0] + ox * miter, cur[1] + oy * miter]);
  }
  return ccw(out);
}

/**
 * Inward miter that PRESERVES vertex count (critical for 1:1 edge→ridge quads).
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
    const n1: Pt = [-e1[1] / l1, e1[0] / l1];
    const n2: Pt = [-e2[1] / l2, e2[0] / l2];
    let nx = n1[0] + n2[0];
    let ny = n1[1] + n2[1];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const dot = Math.max(-0.92, Math.min(0.92, n1[0] * n2[0] + n1[1] * n2[1]));
    const miter = amount / Math.max(0.35, Math.sqrt((1 + dot) / 2));
    out.push([cur[0] + nx * miter, cur[1] + ny * miter]);
  }
  if (out.length !== ring.length) return null;
  const area = Math.abs(signedArea(ccw(out)));
  if (area < 0.2 || area >= Math.abs(signedArea(ring)) * 0.98) return null;
  return ccw(out);
}

function nearestOnSeg(p: Pt, a: Pt, b: Pt): { at: Pt; d: number } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const at: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { at, d: dist(p, at) };
}

function meshDeck(eaves: Pt[], h: number, out: number[]) {
  const ring = ccw(eaves);
  if (ring.length < 3) return;
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const o: Pt = [cx, cy];
  for (let i = 0; i < ring.length; i++) {
    pushTri(out, ring[i], h, ring[(i + 1) % ring.length], h, o, h);
  }
}

function bbox(poly: Pt[]) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, d: maxY - minY };
}

/** Hip / pyramid: one solid face per wall edge. */
export function meshHipPiece(poly: Pt[], height: number, out: number[], overhang = 0.3) {
  const walls = simplifyRing(poly);
  const eaves = expandOut(walls, overhang);
  const peak = Math.max(0.3, height);
  meshDeck(eaves, 0.05, out);

  const box = bbox(eaves);
  const short = Math.min(box.w, box.d);
  // Try a few inset depths so concave / odd rings still get a ridge.
  let ridge: Pt[] | null = null;
  for (const t of [0.38, 0.28, 0.2, 0.14]) {
    const cand = insetRing(eaves, Math.max(0.25, short * t));
    if (cand && cand.length === eaves.length) {
      ridge = cand;
      break;
    }
  }

  if (!ridge) {
    const apex: Pt = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
    for (let i = 0; i < eaves.length; i++) {
      pushTri(out, eaves[i], 0.06, eaves[(i + 1) % eaves.length], 0.06, apex, peak);
    }
    return;
  }

  for (let i = 0; i < eaves.length; i++) {
    const j = (i + 1) % eaves.length;
    pushQuad(out, eaves[i], 0.06, eaves[j], 0.06, ridge[j], peak, ridge[i], peak);
  }
  meshDeck(ridge, peak, out);
}

function onRidge(p: Pt, a: Pt, b: Pt, tol = 0.15): boolean {
  return nearestOnSeg(p, a, b).d < tol;
}

export function splitByRidge(poly: Pt[], a: Pt, b: Pt): { left: Pt[]; right: Pt[] } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const side = (p: Pt) => dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
  const hit = (p: Pt, q: Pt): Pt => {
    const sp = side(p),
      sq = side(q);
    const t = sp / (sp - sq || 1e-12);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const clip = (inside: (p: Pt) => boolean) => {
    const ring = ccw(poly);
    const out: Pt[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const ain = inside(p);
      const bin = inside(q);
      if (ain && bin) out.push(q);
      else if (ain && !bin) out.push(hit(p, q));
      else if (!ain && bin) {
        out.push(hit(p, q));
        out.push(q);
      }
    }
    return simplifyRing(out);
  };
  return {
    left: clip((p) => side(p) >= -1e-6),
    right: clip((p) => side(p) <= 1e-6),
  };
}

function defaultRidge(poly: Pt[], along: "width" | "depth" | "auto"): [Pt, Pt] {
  const box = bbox(poly);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const alongWidth = along === "width" || (along === "auto" && box.w >= box.d);
  return alongWidth
    ? [
        [box.minX + 0.05, cy],
        [box.maxX - 0.05, cy],
      ]
    : [
        [cx, box.minY + 0.05],
        [cx, box.maxY - 0.05],
      ];
}

/** Gable: ridge edge + slope quads from each wall half. */
export function meshGablePiece(poly: Pt[], ridge: [Pt, Pt] | undefined, height: number, out: number[], overhang = 0.3) {
  const walls = simplifyRing(poly);
  // Clean 4-corner rectangles get classic gables; everything else gets a hip piece.
  if (walls.length !== 4 || isConcave(walls)) {
    meshHipPiece(poly, height, out, overhang);
    return;
  }

  const eaves = expandOut(walls, overhang);
  const peak = Math.max(0.3, height);
  meshDeck(eaves, 0.05, out);

  const r = ridge && dist(ridge[0], ridge[1]) > 0.3 ? ridge : defaultRidge(eaves, "auto");
  const { left, right } = splitByRidge(eaves, r[0], r[1]);

  for (const half of [left, right]) {
    if (half.length < 3) continue;
    for (let i = 0; i < half.length; i++) {
      const a = half[i];
      const b = half[(i + 1) % half.length];
      if (onRidge(a, r[0], r[1]) && onRidge(b, r[0], r[1])) continue;
      const na = nearestOnSeg(a, r[0], r[1]).at;
      const nb = nearestOnSeg(b, r[0], r[1]).at;
      const ha = onRidge(a, r[0], r[1]) ? peak : 0.06;
      const hb = onRidge(b, r[0], r[1]) ? peak : 0.06;
      if (dist(na, nb) < 0.1) pushTri(out, a, ha, b, hb, na, peak);
      else pushQuad(out, a, ha, b, hb, nb, peak, na, peak);
    }
  }
}

function meshFlatPiece(poly: Pt[], height: number, out: number[]) {
  meshDeck(expandOut(simplifyRing(poly), 0.15), Math.max(0.14, height * 0.35), out);
}

function meshWing(wing: RoofWingMesh, out: number[]) {
  if (wing.polygon.length < 3 || Math.abs(signedArea(wing.polygon)) < 0.2) return;
  const h = Math.max(0.25, wing.height);
  if (wing.shape === "flat") {
    meshFlatPiece(wing.polygon, h, out);
    return;
  }
  // Prefer hip for anything that isn't a clean elongated bar — Bloxburg auto does this too.
  const ring = simplifyRing(wing.polygon);
  const box = bbox(ring);
  const aspect = Math.max(box.w, box.d) / Math.max(0.5, Math.min(box.w, box.d));
  const cleanGable = wing.shape === "gable" && ring.length === 4 && !isConcave(ring) && aspect >= 1.25 && wing.ridge;
  if (cleanGable) {
    meshGablePiece(wing.polygon, wing.ridge, h, out);
    return;
  }
  meshHipPiece(wing.polygon, h, out);
}

function fallbackWings(poly: Pt[], spec: RoofMeshSpec): RoofWingMesh[] {
  const ring = simplifyRing(poly);
  if (spec.shape === "flat") return [{ polygon: ring, height: spec.height, shape: "flat" }];
  const shape = spec.shape === "hip" || spec.shape === "other" ? "hip" : "gable";
  return [{ polygon: ring, ridge: defaultRidge(ring, spec.ridgeAlong), height: spec.height, shape }];
}

export function buildRoofPositions(planPoly: Pt[], spec: RoofMeshSpec): number[] {
  const wings = spec.wings?.length ? spec.wings : fallbackWings(planPoly, spec);
  const out: number[] = [];
  for (const wing of wings) meshWing(wing, out);
  return out;
}

export function meshOffsetRoof(poly: Pt[], height: number, out: number[]) {
  meshHipPiece(poly, height, out);
}

export function meshDistanceRoof(poly: Pt[], height: number, out: number[]) {
  meshHipPiece(poly, height, out);
}

export function triangulate(ringIn: Pt[]): number[][] {
  const ring = simplifyRing(ringIn);
  if (ring.length < 3) return [];
  const faces: number[][] = [];
  for (let i = 1; i < ring.length - 1; i++) faces.push([0, i, i + 1]);
  return faces;
}
