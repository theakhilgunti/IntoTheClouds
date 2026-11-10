/**
 * UV helpers for photoreal textured exteriors.
 * Model frame: x = east, y = north (meters, footprint centroid origin).
 * Aerial crops are north-up squares of halfSize meters from center to edge.
 */
import type { FacadePreset, Point } from "@/packages/schema/building-model";

/** Map a free-text material (Gemini / OSM) to a stable facade preset. */
export function facadePresetFromMaterial(raw: string | null | undefined): FacadePreset {
  const s = (raw ?? "").toLowerCase();
  if (!s || s === "unknown") return "unknown";
  if (/\bbrick|masonry|clinker\b/.test(s)) return "brick";
  if (/\bvinyl|aluminium|aluminum|clapboard siding|pvc\b/.test(s)) return "vinyl";
  if (/\bstucco|render|plaster|adobe\b/.test(s)) return "stucco";
  if (/\bwood|timber|cedar|clapboard|shingle(?!.*asphalt)\b/.test(s)) return "wood";
  if (/\bconcrete|cinder|block|stone|granite|limestone\b/.test(s)) return "concrete";
  return "unknown";
}

/**
 * UV for a point on a north-up aerial square centered at the model origin.
 * Returns [u, v] in 0..1 (v increases north → top of image).
 */
export function aerialUv(x: number, y: number, halfSize: number): [number, number] {
  const h = Math.max(1e-6, halfSize);
  const u = 0.5 + x / (2 * h);
  const v = 0.5 + y / (2 * h);
  return [u, v];
}

/** Clamp UV into the aerial image (outside crop → edge). */
export function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

export function aerialUvClamped(x: number, y: number, halfSize: number): [number, number] {
  const [u, v] = aerialUv(x, y, halfSize);
  return [clamp01(u), clamp01(v)];
}

/**
 * Wall-face UV in meters → texture repeats.
 * Low repeat rate keeps large dorm walls from looking busy.
 */
export function wallFaceUv(
  alongM: number,
  heightM: number,
  repeatPerMeter = 0.16,
): [number, number] {
  return [alongM * repeatPerMeter, heightM * repeatPerMeter];
}

/** How many texture repeats along a wall segment of given length and height. */
export function wallRepeat(segLen: number, height: number, repeatPerMeter = 0.16): [number, number] {
  return [Math.max(0.35, segLen * repeatPerMeter), Math.max(0.35, height * repeatPerMeter)];
}

/**
 * Aerial UVs for roof vertex positions (Three.js x / z).
 * `framed` meshes sit under a group at `center` with Y-rotation `rotation`.
 */
export function roofAerialUvArray(
  positions: ArrayLike<number>,
  halfSize: number,
  opts: { framed: boolean; center: Point; rotation: number },
): Float32Array {
  const count = Math.floor(positions.length / 3);
  const uvs = new Float32Array(count * 2);
  const cos = Math.cos(opts.rotation);
  const sin = Math.sin(opts.rotation);
  const [cx, cy] = opts.center;
  for (let i = 0; i < count; i++) {
    const lx = positions[i * 3];
    const lz = positions[i * 3 + 2];
    let mx: number;
    let my: number;
    if (opts.framed) {
      const wx = lx * cos + lz * sin;
      const wz = -lx * sin + lz * cos;
      mx = cx + wx;
      my = cy - wz;
    } else {
      mx = lx;
      my = -lz;
    }
    const [u, v] = aerialUvClamped(mx, my, halfSize);
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  return uvs;
}

/**
 * Flat ground / roof polygon UVs from aerial crop.
 * Positions are model-frame [x,y]; output pairs match polygon vertex order.
 */
export function aerialPolygonUvs(poly: Point[], halfSize: number): [number, number][] {
  return poly.map(([x, y]) => aerialUvClamped(x, y, halfSize));
}

/** Extent of a polygon in model meters (AABB half-diagonal for sizing a ground plane). */
export function polygonHalfExtent(poly: Point[]): number {
  if (!poly.length) return 40;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(20, Math.hypot(maxX - minX, maxY - minY) * 0.55 + 8);
}
