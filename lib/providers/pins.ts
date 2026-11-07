/**
 * Hand-verified OpenStreetMap building ids for demo addresses. The geocoder's address point is only
 * approximate, so "closest building" can pick a neighbor; a pin forces the exact house.
 * Key: house number + normalized street, e.g. "17 schuyler ave".
 */
const PINS: Record<string, number> = {
  "17 schuyler ave": 871876464, // verified against OSM addr:housenumber=17 (11 Schuyler Ave is 871876469)
};

export function pinnedWayId(address?: string | null): number | null {
  const first = address?.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
  if (!first) return null;
  const key = first
    .replace(/\bavenue\b/, "ave").replace(/\bstreet\b/, "st").replace(/\broad\b/, "rd").replace(/\bdrive\b/, "dr");
  return PINS[key] ?? null;
}
