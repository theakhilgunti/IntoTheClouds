/** Small geometry helpers. Local frame: meters, x = east, y = north. */
import type { Point } from "@/packages/schema/building-model";

export type LatLng = { lat: number; lng: number };

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function toLocal(origin: LatLng, p: LatLng): Point {
  return [rad(p.lng - origin.lng) * Math.cos(rad(origin.lat)) * R, rad(p.lat - origin.lat) * R];
}

export function fromLocal(origin: LatLng, p: Point): LatLng {
  return { lat: origin.lat + deg(p[1] / R), lng: origin.lng + deg(p[0] / (R * Math.cos(rad(origin.lat)))) };
}

/** Compass bearing (degrees, 0 = north, clockwise) from a to b. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function polygonArea(ring: Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(ring: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest point on segment ab to p. */
export function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return [a[0] + t * dx, a[1] + t * dy];
}

export const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distToRing(p: Point, ring: Point[]): number {
  if (pointInPolygon(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, dist(p, nearestOnSegment(p, ring[i], ring[(i + 1) % ring.length])));
  }
  return best;
}

/** Minimum-area oriented bounding rectangle. u/v are the unit axes; wU/wV the extents along them. */
export function minAreaRect(ring: Point[]) {
  let best: { u: Point; v: Point; wU: number; wV: number; center: Point; area: number } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.1) continue;
    const u: Point = [(x2 - x1) / len, (y2 - y1) / len];
    const v: Point = [-u[1], u[0]];
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
        u, v, wU: maxU - minU, wV: maxV - minV, area,
        center: [mu * u[0] + mv * v[0], mu * u[1] + mv * v[1]],
      };
    }
  }
  if (!best) throw new Error("degenerate polygon");
  return best;
}
