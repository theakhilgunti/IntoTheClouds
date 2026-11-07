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

/** Walls from clipped room polygons. An edge with a neighbor on the outside is interior; the outline is exterior. */
export function wallsAlongOutline(rooms: { zone: string; poly: Pt[] }[]): OutlineWall[] {
  const polys = rooms
    .map((r) => ({ zone: r.zone, poly: ccw(r.poly) }))
    .filter((r) => r.poly.length >= 3);
  const walls: OutlineWall[] = [];
  const seen = new Set<string>();
  for (const room of polys) {
    const poly = room.poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.08) continue;
      const key = edgeKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const rx = (b[1] - a[1]) / len;
      const ry = -(b[0] - a[0]) / len;
      const probe: Pt = [mid[0] + rx * 0.12, mid[1] + ry * 0.12];
      const other = polys.find((o) => o !== room && pointInRing(probe, o.poly));
      walls.push({
        a,
        b,
        exterior: !other,
        zones: other ? [room.zone, other.zone] : [room.zone, null],
      });
    }
  }
  return walls;
}
