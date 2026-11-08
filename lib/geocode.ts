import type { LatLng } from "./geo";
import type { SourceReport } from "./sources";

const UA = "CloudScan-HackRPI/0.1 (hackathon project; contact via GitHub theakhilgunti)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- external JSON, read defensively below
async function getJson(url: string, ms = 10000): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export type Geocoded = LatLng & {
  matched: string;
  provider: string;
  /** OSM building way id when the address search points at a building outline (never a highway). */
  wayId?: number | null;
  /** True when Nominatim only matched a road / place, not a house number. */
  streetOnly?: boolean;
};

/** Nominatim way ids are only useful as building outlines — never treat a highway as a house. */
export function nominatimBuildingWayId(hit: {
  osm_type?: string;
  osm_id?: number | string;
  class?: string;
  type?: string;
  addresstype?: string;
} | null | undefined): number | null {
  if (!hit || hit.osm_type !== "way") return null;
  const id = Number(hit.osm_id);
  if (!Number.isFinite(id)) return null;
  const cls = String(hit.class ?? "").toLowerCase();
  if (cls === "highway" || cls === "railway" || cls === "waterway" || cls === "aeroway") return null;
  if (cls === "building") return id;
  // Building-like POIs sometimes lack class=building but still carry a footprint way.
  if (cls === "amenity" || cls === "office" || cls === "shop" || cls === "tourism" || cls === "leisure") return id;
  return null;
}

export function isNominatimStreetOnly(hit: {
  class?: string;
  type?: string;
  addresstype?: string;
} | null | undefined): boolean {
  if (!hit) return false;
  const cls = String(hit.class ?? "").toLowerCase();
  const addr = String(hit.addresstype ?? "").toLowerCase();
  if (cls === "highway") return true;
  if (addr === "road" || addr === "residential" || addr === "street") {
    // "residential" addresstype is used for both houses and named residential roads.
    return cls === "highway" || cls === "" || cls === "place";
  }
  return false;
}

function metersApart(a: LatLng, b: LatLng): number {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Address -> coordinates. US Census (exact US street ranges) plus OpenStreetMap Nominatim. Both free. */
export async function geocode(address: string, report: SourceReport[]): Promise<Geocoded | null> {
  let census: Geocoded | null = null;
  try {
    const j = await getJson(
      `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`,
    );
    const m = j.result?.addressMatches?.[0];
    if (m) {
      census = { lat: m.coordinates.y, lng: m.coordinates.x, matched: m.matchedAddress, provider: "census" };
      report.push({
        id: "census", name: "US Census Geocoder", status: "used",
        detail: `Matched "${m.matchedAddress}" at ${m.coordinates.y.toFixed(5)}, ${m.coordinates.x.toFixed(5)}.`,
      });
    } else {
      report.push({ id: "census", name: "US Census Geocoder", status: "failed", detail: "No match for that address." });
    }
  } catch (e) {
    report.push({ id: "census", name: "US Census Geocoder", status: "failed", detail: String(e) });
  }

  let nominatim: Geocoded | null = null;
  try {
    const j = await getJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&addressdetails=1&limit=1`,
    );
    const hit = j[0];
    if (hit) {
      const wayId = nominatimBuildingWayId(hit);
      const streetOnly = isNominatimStreetOnly(hit) || wayId == null && String(hit.class ?? "") === "highway";
      nominatim = {
        lat: +hit.lat,
        lng: +hit.lon,
        matched: hit.display_name,
        provider: "nominatim",
        wayId,
        streetOnly: streetOnly || undefined,
      };
      report.push({
        id: "nominatim",
        name: "OpenStreetMap Nominatim",
        status: "used",
        detail: streetOnly
          ? `Only matched the street "${hit.display_name}" — no house number outline.`
          : `Matched "${hit.display_name}".`,
      });
    } else {
      report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: "No match." });
    }
  } catch (e) {
    report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: String(e) });
  }

  if (census && nominatim && metersApart(census, nominatim) < 150) {
    // Census drops the point on the street centerline, often closer to the neighbor.
    // Nominatim's point sits on the building when it has one. Keep Census's cleaned address string.
    return {
      ...census,
      lat: nominatim.streetOnly ? census.lat : nominatim.lat,
      lng: nominatim.streetOnly ? census.lng : nominatim.lng,
      wayId: nominatim.wayId ?? null,
      streetOnly: nominatim.streetOnly,
    };
  }
  // When the two disagree by a long way, trust the Census street match.
  return census ?? nominatim;
}

/** The OSM building (way id) Nominatim associates with an address, if it points at one. Used to pick the right house. */
export async function nominatimBuildingId(address: string): Promise<number | null> {
  try {
    const j = await getJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`);
    return nominatimBuildingWayId(j[0]);
  } catch {
    return null;
  }
}

export type AddressSuggestion = {
  /** Full label shown in the dropdown / filled into the field. */
  label: string;
  /** Short primary line (street / place). */
  primary: string;
  /** City / state / country secondary line. */
  secondary: string;
  lat: number;
  lng: number;
  wayId?: number | null;
};

function splitDisplayName(display: string): { primary: string; secondary: string } {
  const parts = display.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { primary: display, secondary: "" };
  return { primary: parts[0]!, secondary: parts.slice(1, 4).join(", ") };
}

/**
 * Typeahead suggestions for the home address field (Maps-style dropdown).
 * Uses Nominatim search with a small limit — call from a server route so the UA is set.
 */
export async function suggestAddresses(query: string, limit = 6): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const n = Math.max(1, Math.min(8, Math.round(limit)));
  try {
    const j = await getJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=${n}`,
      8000,
    );
    if (!Array.isArray(j)) return [];
    const seen = new Set<string>();
    const out: AddressSuggestion[] = [];
    for (const hit of j) {
      const label = String(hit.display_name ?? "").trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const { primary, secondary } = splitDisplayName(label);
      out.push({
        label,
        primary,
        secondary,
        lat: +hit.lat,
        lng: +hit.lon,
        wayId: nominatimBuildingWayId(hit),
      });
    }
    return out;
  } catch {
    return [];
  }
}
