/** NYC tax lot from the city's MapPLUTO service. Outside New York City this returns null. */
import { plutoAddress } from "./address";
import { dist, toLocal, type LatLng } from "./geo";

const ENDPOINT = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const FIELDS = "Address,NumFloors,NumBldgs,BsmtCode";
const UA = "CloudScan-HackRPI/0.1 (hackathon project)";

export type ParcelHit = {
  address: string;
  /** Exterior ring, longitude then latitude. */
  ring: LatLng[];
  numFloors: number | null;
  numBuildings: number | null;
  /** true / false when the tax record says so. null when the code is missing or unknown. */
  basement: boolean | null;
};

export function inNyc(p: LatLng) {
  return p.lat > 40.49 && p.lat < 40.92 && p.lng > -74.26 && p.lng < -73.7;
}

function basementFromCode(code: unknown): boolean | null {
  const n = typeof code === "number" ? code : parseInt(String(code ?? ""), 10);
  if (n === 0) return false;
  if (n === 1 || n === 2) return true;
  return null;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function largestRing(rings: number[][][]): LatLng[] | null {
  let best: number[][] | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      area += x1 * y2 - x2 * y1;
    }
    if (Math.abs(area) > bestArea) {
      bestArea = Math.abs(area);
      best = ring;
    }
  }
  if (!best || best.length < 4) return null;
  const pts = best.map(([lng, lat]) => ({ lat, lng }));
  if (pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng) pts.pop();
  return pts.length >= 3 ? pts : null;
}

type Raw = { attributes?: Record<string, unknown>; geometry?: { rings?: number[][][] } };

function toHit(raw: Raw): ParcelHit | null {
  const ring = largestRing(raw.geometry?.rings ?? []);
  if (!ring) return null;
  const a = raw.attributes ?? {};
  return {
    address: String(a.Address ?? "").trim(),
    ring,
    numFloors: asNumber(a.NumFloors),
    numBuildings: asNumber(a.NumBldgs),
    basement: basementFromCode(a.BsmtCode),
  };
}

async function query(params: Record<string, string>): Promise<ParcelHit[]> {
  const url = `${ENDPOINT}?${new URLSearchParams({ ...params, outFields: FIELDS, returnGeometry: "true", outSR: "4326", f: "json" })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`MapPLUTO HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? "MapPLUTO query failed");
  return ((j.features ?? []) as Raw[]).map(toHit).filter((p): p is ParcelHit => !!p);
}

function closest(hits: ParcelHit[], at: LatLng, maxMeters: number): ParcelHit | null {
  let best: ParcelHit | null = null;
  let bestD = maxMeters;
  for (const hit of hits) {
    const c = hit.ring.reduce((s, p) => ({ lat: s.lat + p.lat, lng: s.lng + p.lng }), { lat: 0, lng: 0 });
    c.lat /= hit.ring.length;
    c.lng /= hit.ring.length;
    const d = dist(toLocal(at, c), [0, 0]);
    if (d < bestD) {
      best = hit;
      bestD = d;
    }
  }
  return best;
}

/** Lot for an address, or the lot that contains `at` when no address is given. */
export async function lookupParcel(at: LatLng, address?: string | null): Promise<ParcelHit | null> {
  if (!inNyc(at)) return null;
  const formatted = plutoAddress(address);
  if (formatted) {
    const where = `Address='${formatted.replace(/'/g, "''")}'`;
    const hits = await query({ where });
    const near = closest(hits, at, 200);
    if (near) return near;
  }
  const hits = await query({
    geometry: `${at.lng},${at.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  return hits[0] ?? null;
}
