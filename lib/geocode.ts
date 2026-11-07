import type { LatLng } from "./geo";
import type { SourceReport } from "./sources";

const UA = "CloudScan-HackRPI/0.1 (hackathon project; contact via GitHub theakhilgunti)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- external JSON, read defensively below
async function getJson(url: string, ms = 10000): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export type Geocoded = LatLng & { matched: string; provider: string };

/** Address -> coordinates. US Census (exact US street ranges), then OpenStreetMap Nominatim. Both free. */
export async function geocode(address: string, report: SourceReport[]): Promise<Geocoded | null> {
  try {
    const j = await getJson(
      `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`,
    );
    const m = j.result?.addressMatches?.[0];
    if (m) {
      report.push({
        id: "census", name: "US Census Geocoder", status: "used",
        detail: `Matched "${m.matchedAddress}" at ${m.coordinates.y.toFixed(5)}, ${m.coordinates.x.toFixed(5)}.`,
      });
      return { lat: m.coordinates.y, lng: m.coordinates.x, matched: m.matchedAddress, provider: "census" };
    }
    report.push({ id: "census", name: "US Census Geocoder", status: "failed", detail: "No match for that address." });
  } catch (e) {
    report.push({ id: "census", name: "US Census Geocoder", status: "failed", detail: String(e) });
  }

  try {
    const j = await getJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`,
    );
    if (j[0]) {
      report.push({
        id: "nominatim", name: "OpenStreetMap Nominatim", status: "used",
        detail: `Matched "${j[0].display_name}".`,
      });
      return { lat: +j[0].lat, lng: +j[0].lon, matched: j[0].display_name, provider: "nominatim" };
    }
    report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: "No match." });
  } catch (e) {
    report.push({ id: "nominatim", name: "OpenStreetMap Nominatim", status: "failed", detail: String(e) });
  }
  return null;
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
