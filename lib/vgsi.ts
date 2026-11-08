/**
 * Vision Government Solutions (gis.vgsi.com / arcgis.vgsi.com) assessor maps.
 *
 * Covered towns expose parcel lots and often building footprints via PropMap.
 * These are appraisal sketches / shells — not interior room plans. Use them as
 * footprint + program cues when OSM is thin.
 *
 * Self-contained (no @/ or ./geo) so node:test can load the parsers without Next aliases.
 */
import type { BuildingUse } from "./layout-use";

export type LatLng = { lat: number; lng: number };
type Point = [number, number];

const UA = "CloudScan-HackRPI/0.1 (hackathon project)";
const ROOT = "https://arcgis.vgsi.com/server/rest/services";
const EARTH_M = 6371008.8;

function toLocal(origin: LatLng, p: LatLng): Point {
  const rad = (d: number) => (d * Math.PI) / 180;
  return [
    rad(p.lng - origin.lng) * Math.cos(rad(origin.lat)) * EARTH_M,
    rad(p.lat - origin.lat) * EARTH_M,
  ];
}

function dist(a: Point, b: Point) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export type VgsiHit = {
  municipality: string;
  address: string | null;
  /** Building footprint ring in WGS84 when a Buildings layer exists. */
  buildingRing: LatLng[] | null;
  /** Tax parcel / lot ring in WGS84. */
  parcelRing: LatLng[] | null;
  stories: number | null;
  style: string | null;
  occupancy: string | null;
  useDesc: string | null;
  rooms: number | null;
  beds: number | null;
  baths: number | null;
  livingAreaSqft: number | null;
  detail: string;
};

type LayerRef = { folder: string; service: string; id: number; name: string };
type TownLayers = { folder: string; service: string; buildings: LayerRef | null; parcels: LayerRef | null };

let folderCache: string[] | null = null;
const townCache = new Map<string, TownLayers | null>();

async function getJson(url: string, ms = 8000): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`VGSI HTTP ${res.status}`);
  return res.json();
}

async function listFolders(): Promise<string[]> {
  if (folderCache) return folderCache;
  const j = (await getJson(`${ROOT}?f=pjson`)) as { folders?: string[] };
  folderCache = (j.folders ?? []).filter((f) => f !== "Basemaps" && f !== "Utilities");
  return folderCache;
}

/** "Quincy, MA" / "New Haven CT" → Quincy_MA / New_Haven_CT. */
export function placeKeyFromAddress(address: string | null | undefined): { city: string; state: string } | null {
  if (!address) return null;
  const m = address.match(/,\s*([^,]+?)\s*,\s*([A-Za-z]{2})(?:\s+\d{5})?(?:\s*,|$)/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
  const m2 = address.match(/,\s*([^,]+?)\s+([A-Za-z]{2})(?:\s+\d{5})?\s*$/);
  if (m2) return { city: m2[1].trim(), state: m2[2].toUpperCase() };
  return null;
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Match address city/state to an ArcGIS folder like Quincy_MA or Tioga_County_PA. */
export function matchVgsiFolder(folders: string[], city: string, state: string): string | null {
  const st = state.toUpperCase();
  const cityTok = normalizeToken(city);
  if (!cityTok || cityTok.length < 2) return null;
  const candidates = folders.filter((f) => f.endsWith(`_${st}`));
  const scored = candidates
    .map((f) => {
      const base = f.slice(0, -(st.length + 1)); // drop _ST
      const name = normalizeToken(base.replace(/_/g, " "));
      let score = 0;
      if (name === cityTok) score = 100;
      else if (name.startsWith(cityTok + " ") || name.endsWith(" " + cityTok) || name.includes(" " + cityTok + " ")) score = 80;
      else if (name.includes(cityTok) && cityTok.length >= 4) score = 50;
      else if (cityTok.includes(name) && name.length >= 4) score = 40;
      // County portals: "Tioga County" → Tioga_County_PA
      if (name.endsWith(" county") && cityTok.includes(name.replace(/ county$/, ""))) score = Math.max(score, 70);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.f ?? null;
}

async function resolveTown(folder: string): Promise<TownLayers | null> {
  if (townCache.has(folder)) return townCache.get(folder)!;
  try {
    const folderJson = (await getJson(`${ROOT}/${folder}?f=pjson`)) as {
      services?: { name: string; type: string }[];
    };
    const svc =
      folderJson.services?.find((s) => s.type === "MapServer" && /PropMap$/i.test(s.name.split("/").pop() ?? "")) ??
      folderJson.services?.find((s) => s.type === "MapServer");
    if (!svc) {
      townCache.set(folder, null);
      return null;
    }
    const map = (await getJson(`${ROOT}/${svc.name}/MapServer?f=pjson`)) as {
      layers?: { id: number; name: string }[];
    };
    const layers = map.layers ?? [];
    const pick = (pred: (n: string) => boolean): LayerRef | null => {
      const hit = layers.find((l) => pred(l.name.toLowerCase()));
      return hit ? { folder, service: svc.name, id: hit.id, name: hit.name } : null;
    };
    const buildings =
      pick((n) => n === "buildings" || n.startsWith("buildings ")) ??
      pick((n) => n.includes("building") && !n.includes("boundary"));
    const parcels =
      pick((n) => n.includes("parcel boundary") || n.includes("parcel boundaries") || n === "parcels" || n === "tax parcels") ??
      pick((n) => n.includes("property boundar")) ??
      pick((n) => n.includes("parcel") && !n.includes("hook") && !n.includes("dimension") && !n.includes("annotation"));
    const town: TownLayers = { folder, service: svc.name, buildings, parcels };
    townCache.set(folder, town);
    return town;
  } catch {
    townCache.set(folder, null);
    return null;
  }
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

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickAttr(attrs: Record<string, unknown>, patterns: RegExp[]): unknown {
  const keys = Object.keys(attrs);
  for (const re of patterns) {
    const k = keys.find((key) => re.test(key));
    if (k != null && attrs[k] != null && attrs[k] !== "") return attrs[k];
  }
  return null;
}

/** Pull stories / style / rooms from heterogeneous assessor attribute schemas. */
export function parseAssessorAttrs(attrs: Record<string, unknown>): Pick<
  VgsiHit,
  "address" | "stories" | "style" | "occupancy" | "useDesc" | "rooms" | "beds" | "baths" | "livingAreaSqft"
> {
  const addressRaw = pickAttr(attrs, [
    /^location$/i,
    /loc_?addr/i,
    /prcl_l$/i,
    /site_?addr/i,
    /prop_?addr/i,
    /address/i,
  ]);
  const storiesRaw = pickAttr(attrs, [/cns_?stories/i, /^stories$/i, /num_?stor/i, /story/i]);
  let stories = asNumber(storiesRaw);
  if (stories == null && typeof storiesRaw === "string") {
    const m = storiesRaw.match(/(\d+(?:\.\d+)?)/);
    stories = m ? parseFloat(m[1]) : null;
  }
  if (stories != null && stories > 0 && stories < 1) stories = 1; // "0.5" etc.
  if (stories != null) stories = Math.max(1, Math.min(12, Math.round(stories)));

  const style = String(pickAttr(attrs, [/csn_?style/i, /style_?desc/i, /^style$/i]) ?? "").trim() || null;
  const occupancy = String(pickAttr(attrs, [/csn_?occ/i, /occ_?desc/i, /occupancy/i]) ?? "").trim() || null;
  const useDesc = String(pickAttr(attrs, [/lnd_?use_?desc/i, /use_?desc/i, /land_?use/i]) ?? "").trim() || null;
  const rooms = asNumber(pickAttr(attrs, [/total_?rooms/i, /cns_?total_?rooms/i, /^rooms$/i]));
  const beds = asNumber(pickAttr(attrs, [/total_?beds/i, /cns_?total_?beds/i, /bedrooms?/i, /^beds$/i]));
  const baths = asNumber(pickAttr(attrs, [/total_?baths/i, /cns_?total_?baths/i, /bathrooms?/i, /^baths$/i]));
  const livingAreaSqft = asNumber(pickAttr(attrs, [/living_?area/i, /cns_?area_?effective/i, /area_?living/i]));

  return {
    address: addressRaw != null ? String(addressRaw).trim() || null : null,
    stories,
    style,
    occupancy,
    useDesc,
    rooms,
    beds,
    baths,
    livingAreaSqft,
  };
}

/** Map Vision style / occupancy / land-use strings onto BuildingUse. */
export function buildingUseFromAssessor(opts: {
  style?: string | null;
  occupancy?: string | null;
  useDesc?: string | null;
}): BuildingUse | null {
  const blob = [opts.style, opts.occupancy, opts.useDesc].filter(Boolean).join(" ").toLowerCase();
  if (!blob) return null;
  if (/\b(hospital|clinic|medical)\b/.test(blob)) return "hospital";
  if (/\b(universit|college)\b/.test(blob)) return "university";
  if (/\blibrary\b/.test(blob)) return "library";
  if (/\b(school|classroom|elementary|high school)\b/.test(blob)) return "school";
  if (/\b(church|chapel|temple|mosque|synagogue|worship)\b/.test(blob)) return "church";
  if (/\b(hotel|motel|inn)\b/.test(blob)) return "hotel";
  if (/\b(dorm|residence hall|boarding)\b/.test(blob)) return "dormitory";
  if (/\b(apartments?|apt\.?|multi[- ]?family|condo|townhouses?|town houses?)\b/.test(blob)) return "apartments";
  if (/\b(warehouse|industrial|factory|manufactur)\b/.test(blob)) return "warehouse";
  if (/\boffice\b/.test(blob)) return "office";
  if (/\b(commercial|retail|store|shop)\b/.test(blob)) return "commercial";
  if (/\b(single[- ]?family|residential|colonial|cape|ranch|bungalow|split|victorian|contemporary|raised ranch)\b/.test(blob)) {
    return "house";
  }
  return null;
}

type RawFeature = { attributes?: Record<string, unknown>; geometry?: { rings?: number[][][] } };

async function queryLayer(layer: LayerRef, at: LatLng, distanceM: number): Promise<RawFeature[]> {
  const params = new URLSearchParams({
    geometry: `${at.lng},${at.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(distanceM),
    units: "esriSRUnit_Meter",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "5",
    f: "json",
  });
  const j = (await getJson(`${ROOT}/${layer.service}/MapServer/${layer.id}/query?${params}`)) as {
    features?: RawFeature[];
    error?: { message?: string };
  };
  if (j.error) throw new Error(j.error.message ?? "VGSI query failed");
  return j.features ?? [];
}

function closestFeature(features: RawFeature[], at: LatLng, maxM: number): RawFeature | null {
  let best: RawFeature | null = null;
  let bestD = maxM;
  for (const f of features) {
    const ring = largestRing(f.geometry?.rings ?? []);
    if (!ring) continue;
    const c = ring.reduce((s, p) => ({ lat: s.lat + p.lat, lng: s.lng + p.lng }), { lat: 0, lng: 0 });
    c.lat /= ring.length;
    c.lng /= ring.length;
    const d = dist(toLocal(at, c), [0, 0]);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/** Convert a WGS84 ring into a model-local footprint centered on its centroid. */
export function ringToLocalFootprint(ring: LatLng[], origin: LatLng): Point[] {
  const local = ring.map((p) => toLocal(origin, p));
  const cx = local.reduce((s, p) => s + p[0], 0) / local.length;
  const cy = local.reduce((s, p) => s + p[1], 0) / local.length;
  return local.map(([x, y]) => [x - cx, y - cy] as Point);
}

/**
 * Look up Vision assessor geometry + cues for an address in a covered municipality.
 * Returns null when the city is not on arcgis.vgsi.com or nothing intersects.
 */
export async function lookupVgsi(at: LatLng, address?: string | null): Promise<VgsiHit | null> {
  const place = placeKeyFromAddress(address);
  if (!place) return null;
  const folders = await listFolders();
  const folder = matchVgsiFolder(folders, place.city, place.state);
  if (!folder) return null;
  const town = await resolveTown(folder);
  if (!town || (!town.buildings && !town.parcels)) return null;

  let buildingRing: LatLng[] | null = null;
  let parcelRing: LatLng[] | null = null;
  let attrs: Record<string, unknown> = {};

  if (town.buildings) {
    try {
      const feats = await queryLayer(town.buildings, at, 45);
      const best = closestFeature(feats, at, 60);
      if (best) buildingRing = largestRing(best.geometry?.rings ?? []);
    } catch {
      /* building layer optional */
    }
  }
  if (town.parcels) {
    try {
      const feats = await queryLayer(town.parcels, at, 25);
      const best = closestFeature(feats, at, 80) ?? feats[0] ?? null;
      if (best) {
        parcelRing = largestRing(best.geometry?.rings ?? []);
        attrs = best.attributes ?? {};
      }
    } catch {
      /* parcel optional */
    }
  }

  if (!buildingRing && !parcelRing) return null;
  const parsed = parseAssessorAttrs(attrs);
  const bits = [
    buildingRing ? "building footprint" : null,
    parcelRing ? "tax parcel" : null,
    parsed.stories != null ? `${parsed.stories} stories` : null,
    parsed.style,
    parsed.occupancy,
  ].filter(Boolean);
  return {
    municipality: folder.replace(/_/g, " "),
    address: parsed.address,
    buildingRing,
    parcelRing,
    stories: parsed.stories,
    style: parsed.style,
    occupancy: parsed.occupancy,
    useDesc: parsed.useDesc,
    rooms: parsed.rooms,
    beds: parsed.beds,
    baths: parsed.baths,
    livingAreaSqft: parsed.livingAreaSqft,
    detail: `${bits.join(", ")} via Vision (${folder}).`,
  };
}

/** Test helpers — clear discovery caches between unit tests. */
export function _resetVgsiCachesForTests() {
  folderCache = null;
  townCache.clear();
}
