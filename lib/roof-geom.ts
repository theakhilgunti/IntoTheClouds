/**
 * Simple sealed roof prisms from footprint volumes.
 *
 * Each wing is an oriented rectangle:
 *  - gable → two slope quads + two end triangles along the long axis
 *  - hip   → same layout with a shortened ridge (hip ends)
 *  - flat  → opaque deck
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

/**
 * Oriented bounding box of a ring — used so rotated houses get aligned ridges,
 * not world-axis AABB garbage.
 */
function minAreaRect(ringIn: Pt[]) {
  const ring = ccw(ringIn);
  let best: {
    u: Pt; v: Pt; wU: number; wV: number; center: Pt; minU: number; maxU: number; minV: number; maxV: number; area: number;
  } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.05) continue;
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
  if (!best) {
    const box = bbox(ring);
    return {
      u: [1, 0] as Pt, v: [0, 1] as Pt, wU: box.w, wV: box.d, area: box.w * box.d,
      minU: box.minX, maxU: box.maxX, minV: box.minY, maxV: box.maxY,
      center: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2] as Pt,
    };
  }
  return best;
}

function corner(r: ReturnType<typeof minAreaRect>, su: number, sv: number): Pt {
  return [
    r.center[0] + r.u[0] * su * (r.wU / 2) + r.v[0] * sv * (r.wV / 2),
    r.center[1] + r.u[1] * su * (r.wU / 2) + r.v[1] * sv * (r.wV / 2),
  ];
}

/**
 * Gable over the real eaves outline: each wall edge slopes up to the ridge.
 * Ridge verts are real mesh peaks (not a center fan / pyramid).
 */
export function meshGablePiece(poly: Pt[], ridge: [Pt, Pt] | undefined, height: number, out: number[], overhang = 0.3) {
  const walls = simplifyRing(poly);
  if (walls.length < 3) return;
  const eaves = expandOut(walls, overhang);
  const peak = Math.max(0.3, height);
  const eaveH = 0.05;
  const r = ridge && dist(ridge[0], ridge[1]) > 0.25 ? ridge : defaultRidge(eaves, "auto");

  for (let i = 0; i < eaves.length; i++) {
    const a = eaves[i];
    const b = eaves[(i + 1) % eaves.length];
    const na = nearestOnSeg(a, r[0], r[1]).at;
    const nb = nearestOnSeg(b, r[0], r[1]).at;
    // Skip the ridge-top edge itself if we ever emit one.
    if (dist(na, a) < 0.08 && dist(nb, b) < 0.08) continue;
    if (dist(na, nb) < 0.08) pushTri(out, a, eaveH, b, eaveH, na, peak);
    else pushQuad(out, a, eaveH, b, eaveH, nb, peak, na, peak);
  }
}

/** Compact hip: short ridge + edge-to-ridge slopes (no apex cone, no floor deck). */
export function meshHipPiece(poly: Pt[], height: number, out: number[], overhang = 0.3) {
  const walls = simplifyRing(poly);
  if (walls.length < 3) return;
  const base = walls.length <= 6 && !isConcave(walls) ? walls : snapToObb(walls);
  const eaves = expandOut(base, overhang);
  const peak = Math.max(0.3, height);
  const eaveH = 0.05;
  const r = defaultRidge(eaves, "auto");
  const dx = r[1][0] - r[0][0],
    dy = r[1][1] - r[0][1];
  const len = Math.hypot(dx, dy) || 1;
  const inset = Math.min(len * 0.28, Math.min(...eaves.map((p) => nearestOnSeg(p, r[0], r[1]).d)) * 0.9, len / 2 - 0.1);
  const ux = dx / len,
    uy = dy / len;
  const ridge: [Pt, Pt] = [
    [r[0][0] + ux * Math.max(0.15, inset), r[0][1] + uy * Math.max(0.15, inset)],
    [r[1][0] - ux * Math.max(0.15, inset), r[1][1] - uy * Math.max(0.15, inset)],
  ];
  meshGablePiece(eaves, ridge, peak, out, 0);
}

function snapToObb(poly: Pt[]): Pt[] {
  const r = minAreaRect(poly);
  return ccw([corner(r, -1, -1), corner(r, 1, -1), corner(r, 1, 1), corner(r, -1, 1)]);
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
  const r = minAreaRect(poly);
  const alongU =
    along === "auto"
      ? r.wU >= r.wV
      : along === "width"
        ? Math.abs(r.u[0]) >= Math.abs(r.u[1])
        : Math.abs(r.u[1]) >= Math.abs(r.u[0]);
  // For "width"/"depth" in model frame, prefer world axes when close.
  let axis = alongU ? r.u : r.v;
  let half = (alongU ? r.wU : r.wV) / 2 - 0.05;
  if (along === "width") {
    axis = Math.abs(r.u[0]) >= Math.abs(r.v[0]) ? r.u : r.v;
    half = (Math.abs(r.u[0]) >= Math.abs(r.v[0]) ? r.wU : r.wV) / 2 - 0.05;
  } else if (along === "depth") {
    axis = Math.abs(r.u[1]) >= Math.abs(r.v[1]) ? r.u : r.v;
    half = (Math.abs(r.u[1]) >= Math.abs(r.v[1]) ? r.wU : r.wV) / 2 - 0.05;
  }
  return [
    [r.center[0] - axis[0] * half, r.center[1] - axis[1] * half],
    [r.center[0] + axis[0] * half, r.center[1] + axis[1] * half],
  ];
}

function meshFlatPiece(poly: Pt[], height: number, out: number[]) {
  meshDeck(expandOut(simplifyRing(poly), 0.15), Math.max(0.14, height * 0.35), out);
}

function meshWing(wing: RoofWingMesh, out: number[]) {
  if (wing.polygon.length < 3 || Math.abs(signedArea(wing.polygon)) < 0.2) return;
  const h = Math.max(0.25, wing.height);
  const overhang = 0.3;
  if (wing.shape === "flat") {
    meshFlatPiece(wing.polygon, h, out);
    return;
  }
  if (wing.shape === "hip") {
    meshHipPiece(wing.polygon, h, out, overhang);
    return;
  }
  meshGablePiece(wing.polygon, wing.ridge, h, out, overhang);
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
