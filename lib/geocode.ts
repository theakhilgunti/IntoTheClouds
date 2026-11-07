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
  /** OSM way id when the address search points at a building outline. */
  wayId?: number | null;
};

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
      const wayId = hit.osm_type === "way" ? Number(hit.osm_id) : null;
      nominatim = { lat: +hit.lat, lng: +hit.lon, matched: hit.display_name, provider: "nominatim", wayId };
      report.push({
        id: "nominatim", name: "OpenStreetMap Nominatim", status: "used",
        detail: `Matched "${hit.display_name}".`,
      });
    } else {
      report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: "No match." });
    }
  } catch (e) {
    report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: String(e) });
  }

  if (census && nominatim && metersApart(census, nominatim) < 150) {
    // Census drops the point on the street centerline, often closer to the neighbor.
    // Nominatim's point sits on the building. Keep Census's cleaned address string.
    return { ...census, lat: nominatim.lat, lng: nominatim.lng, wayId: nominatim.wayId ?? null };
  }
  // When the two disagree by a long way, trust the Census street match.
  return census ?? nominatim;
}

/** The OSM building (way id) Nominatim associates with an address, if it points at one. Used to pick the right house. */
export async function nominatimBuildingId(address: string): Promise<number | null> {
  try {
    const j = await getJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`);
    return j[0]?.osm_type === "way" ? Number(j[0].osm_id) : null;
  } catch {
    return null;
  }
}
