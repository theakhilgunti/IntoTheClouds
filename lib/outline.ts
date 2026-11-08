/**
 * Clip a room plan to the mapped footprint (the yellow outline).
 * The clip window is an axis-aligned rectangle, so a concave outline still cuts correctly.
 */
export type Pt = [number, number];

export type OutlineWall = {
  a: Pt;
  b: Pt;
  exterior: boolean;
  zones: [string, string | null];
};

export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function clean(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of poly) {
    const q: Pt = [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(q[0] - prev[0], q[1] - prev[1]) > 1e-3) out.push(q);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-3) out.pop();
  }
  return out;
}

function ccw(poly: Pt[]): Pt[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

function dropCollinear(poly: Pt[]): Pt[] {
  if (poly.length < 3) return poly;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    const cross = (cur[0] - prev[0]) * (next[1] - prev[1]) - (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (Math.abs(cross) > 1e-3) out.push(cur);
  }
  return out.length >= 3 ? out : poly;
}

/** Keep the part of `poly` on the inside of one infinite edge. */
function clipHalfPlane(poly: Pt[], inside: (p: Pt) => boolean, cross: (a: Pt, b: Pt) => Pt): Pt[] {
  if (poly.length === 0) return [];
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain && bin) out.push(b);
    else if (ain && !bin) out.push(cross(a, b));
    else if (!ain && bin) {
      out.push(cross(a, b));
      out.push(b);
    }
  }
  return clean(out);
}

/** `poly` ∩ rectangle. The rectangle is the clip, so a stepped outline stays stepped. */
export function clipPolyToRect(poly: Pt[], r: { x0: number; y0: number; x1: number; y1: number }): Pt[] {
  const xAt = (a: Pt, b: Pt, x: number): Pt => {
    const t = (x - a[0]) / (b[0] - a[0] || 1e-12);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  const yAt = (a: Pt, b: Pt, y: number): Pt => {
    const t = (y - a[1]) / (b[1] - a[1] || 1e-12);
    return [a[0] + t * (b[0] - a[0]), y];
  };
  let p = poly;
  p = clipHalfPlane(p, (q) => q[0] >= r.x0 - 1e-6, (a, b) => xAt(a, b, r.x0));
  p = clipHalfPlane(p, (q) => q[0] <= r.x1 + 1e-6, (a, b) => xAt(a, b, r.x1));
  p = clipHalfPlane(p, (q) => q[1] >= r.y0 - 1e-6, (a, b) => yAt(a, b, r.y0));
  p = clipHalfPlane(p, (q) => q[1] <= r.y1 + 1e-6, (a, b) => yAt(a, b, r.y1));
  return dropCollinear(ccw(p));
}

/** Split a polygon by the vertical line x = ridge. Both pieces include the cut. */
export function splitAtX(poly: Pt[], ridge: number): { neg: Pt[]; pos: Pt[] } {
  const xAt = (a: Pt, b: Pt): Pt => {
    const t = (ridge - a[0]) / (b[0] - a[0] || 1e-12);
    return [ridge, a[1] + t * (b[1] - a[1])];
  };
  return {
    neg: dropCollinear(ccw(clipHalfPlane(poly, (p) => p[0] <= ridge + 1e-6, xAt))),
    pos: dropCollinear(ccw(clipHalfPlane(poly, (p) => p[0] >= ridge - 1e-6, xAt))),
  };
}

/** Split a polygon by the horizontal line y = ridge. */
export function splitAtY(poly: Pt[], ridge: number): { neg: Pt[]; pos: Pt[] } {
  const yAt = (a: Pt, b: Pt): Pt => {
    const t = (ridge - a[1]) / (b[1] - a[1] || 1e-12);
    return [a[0] + t * (b[0] - a[0]), ridge];
  };
  return {
    neg: dropCollinear(ccw(clipHalfPlane(poly, (p) => p[1] <= ridge + 1e-6, yAt))),
    pos: dropCollinear(ccw(clipHalfPlane(poly, (p) => p[1] >= ridge - 1e-6, yAt))),
  };
}

/** True when the ring bends both ways (a step, L, or courtyard notch). */
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

/** Add vertices along long edges so pitched roofs have enough samples. */
export function densifyPoly(poly: Pt[], maxEdge: number): Pt[] {
  const ring = ccw(poly);
  if (ring.length < 2 || maxEdge <= 0) return ring;
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / maxEdge);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Push each vertex outward by `dist` meters so the eaves hang past the walls. */
export function expandPoly(poly: Pt[], dist: number): Pt[] {
  if (poly.length < 3 || Math.abs(dist) < 1e-6) return ccw(poly);
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
    // CCW ring: outward is the right-hand normal.
    const o1: Pt = [e1[1] / l1, -e1[0] / l1];
    const o2: Pt = [e2[1] / l2, -e2[0] / l2];
    let ox = o1[0] + o2[0];
    let oy = o1[1] + o2[1];
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol;
    oy /= ol;
    const dot = Math.max(-0.95, Math.min(0.95, o1[0] * o2[0] + o1[1] * o2[1]));
    const miter = dist / Math.max(0.35, Math.sqrt((1 + dot) / 2));
    out.push([cur[0] + ox * miter, cur[1] + oy * miter]);
  }
  return dropCollinear(ccw(out));
}

/**
 * Grow the eaves without ripping concave corners.
 * Miter offsets self-intersect on steps, so those outlines scale out from the centroid instead.
 */
export function expandPolySafe(poly: Pt[], dist: number): Pt[] {
  if (poly.length < 3 || Math.abs(dist) < 1e-6) return ccw(poly);
  if (!isConcave(poly)) {
    const grown = expandPoly(poly, dist);
    if (grown.length >= 3 && Math.abs(signedArea(grown)) > Math.abs(signedArea(poly)) * 0.5) return grown;
  }
  const ring = ccw(poly);
  let cx = 0, cy = 0;
  for (const p of ring) {
    cx += p[0];
    cy += p[1];
  }
  cx /= ring.length;
  cy /= ring.length;
  return ring.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * dist, y + (dy / len) * dist] as Pt;
  });
}

/** Shortest distance from a point to the edges of a ring. */
export function distToEdges(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 0) + xi) inside = !inside;
  }
  return inside;
}

function edgeKey(a: Pt, b: Pt): string {
  const q = (n: number) => Math.round(n * 100) / 100;
  const s = (p: Pt) => `${q(p[0])},${q(p[1])}`;
  const u = s(a);
  const v = s(b);
  return u < v ? `${u}|${v}` : `${v}|${u}`;
}

const NEIGHBOR_PROBE_DISTS = [0.08, 0.16, 0.28, 0.45, 0.7];

/**
 * Pull nearly-adjacent room edges onto a shared line so footprint clipping gaps
 * still produce interior walls (and therefore doors).
 */
export function snapNearRoomEdges(
  rooms: { zone: string; poly: Pt[] }[],
  maxGap = 0.55,
): { zone: string; poly: Pt[] }[] {
  const out = rooms
    .map((r) => ({ zone: r.zone, poly: ccw(r.poly).map((p) => [p[0], p[1]] as Pt) }))
    .filter((r) => r.poly.length >= 3);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (out[i].zone === out[j].zone) continue;
      const A = out[i].poly;
      const B = out[j].poly;
      for (let ai = 0; ai < A.length; ai++) {
        const a0 = A[ai];
        const a1 = A[(ai + 1) % A.length];
        const aLen = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
        if (aLen < 0.5) continue;
        const aUx = (a1[0] - a0[0]) / aLen;
        const aUy = (a1[1] - a0[1]) / aLen;
        for (let bi = 0; bi < B.length; bi++) {
          const b0 = B[bi];
          const b1 = B[(bi + 1) % B.length];
          const bLen = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
          if (bLen < 0.5) continue;
          const bUx = (b1[0] - b0[0]) / bLen;
          const bUy = (b1[1] - b0[1]) / bLen;
          // Opposite / parallel edges (facing each other).
          const dot = aUx * bUx + aUy * bUy;
          if (Math.abs(dot) < 0.92) continue;
          const midA: Pt = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2];
          const midB: Pt = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2];
          const gap = Math.hypot(midA[0] - midB[0], midA[1] - midB[1]);
          if (gap > maxGap || gap < 1e-4) continue;
          // Project midA onto B's infinite line; require overlap along the edge.
          const nx = -aUy, ny = aUx;
          const sep = (midB[0] - midA[0]) * nx + (midB[1] - midA[1]) * ny;
          if (Math.abs(sep) > maxGap) continue;
          const mid: Pt = [(midA[0] + midB[0]) / 2, (midA[1] + midB[1]) / 2];
          // Snap both edges onto the midline, preserving length direction of A.
          const half = Math.min(aLen, bLen) / 2;
          A[ai] = [mid[0] - aUx * half, mid[1] - aUy * half];
          A[(ai + 1) % A.length] = [mid[0] + aUx * half, mid[1] + aUy * half];
          B[bi] = [mid[0] + aUx * half, mid[1] + aUy * half];
          B[(bi + 1) % B.length] = [mid[0] - aUx * half, mid[1] - aUy * half];
        }
      }
    }
  }
  return out.map((r) => ({ zone: r.zone, poly: dropCollinear(ccw(r.poly)) }));
}

/** Walls from clipped room polygons. An edge with a neighbor on the outside is interior; the outline is exterior. */
export function wallsAlongOutline(rooms: { zone: string; poly: Pt[] }[]): OutlineWall[] {
  const polys = snapNearRoomEdges(rooms)
    .map((r) => ({ zone: r.zone, poly: ccw(r.poly) }))
    .filter((r) => r.poly.length >= 3);
  const walls: OutlineWall[] = [];
  const byKey = new Map<string, OutlineWall>();
  for (const room of polys) {
    const poly = room.poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.08) continue;
      const key = edgeKey(a, b);
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const rx = (b[1] - a[1]) / len;
      const ry = -(b[0] - a[0]) / len;
      // Probe both sides at several distances — clip gaps often exceed 12 cm.
      let other: (typeof polys)[number] | undefined;
      for (const d of NEIGHBOR_PROBE_DISTS) {
        const probeA: Pt = [mid[0] + rx * d, mid[1] + ry * d];
        const probeB: Pt = [mid[0] - rx * d, mid[1] - ry * d];
        other =
          polys.find((o) => o !== room && o.zone !== room.zone && pointInRing(probeA, o.poly)) ??
          polys.find((o) => o !== room && o.zone !== room.zone && pointInRing(probeB, o.poly));
        if (other) break;
      }
      const existing = byKey.get(key);
      if (existing) {
        // Same edge seen from the adjoining room — mark interior and fill both zones.
        if (other || existing.zones[0] !== room.zone) {
          existing.exterior = false;
          if (other && !existing.zones.includes(other.zone)) {
            existing.zones = [existing.zones[0], other.zone];
          } else if (!existing.zones.includes(room.zone)) {
            existing.zones = [existing.zones[0], room.zone];
          }
        }
        continue;
      }
      const wall: OutlineWall = {
        a,
        b,
        exterior: !other,
        zones: other ? [room.zone, other.zone] : [room.zone, null],
      };
      byKey.set(key, wall);
      walls.push(wall);
    }
  }
  return walls;
}
