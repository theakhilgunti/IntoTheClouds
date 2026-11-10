/**
 * Hand-verified OpenStreetMap building ids for demo addresses. The geocoder's address point is only
 * approximate, so "closest building" can pick a neighbor; a pin forces the exact house.
 * Key: house number + normalized street, e.g. "17 schuyler ave".
 */
const PINS: Record<string, number> = {
  "17 schuyler ave": 871876464, // verified against OSM addr:housenumber=17 (11 Schuyler Ave is 871876469)
  // 45 Brunswick Rd — pin when OSM way is confirmed; exterior overrides still apply by address.
  // East Hills — verified against OSM addr tags (TEX-10 Street View comparison).
  "3 east hills blvd": 870386677,
  "3 east hills boulevard": 870386677,
  // Nominatim's "1 Andover Dr" way is not a building; pin nearest mapped house on Andover.
  "1 andover dr": 870588583, // 2 Andover Drive (OSM has no building for #1)
  "2 andover dr": 870588583,
};

export function pinnedWayId(address?: string | null): number | null {
  const first = address?.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
  if (!first) return null;
  const key = first
    .replace(/\be\b(?=\s)/, "east")
    .replace(/\bw\b(?=\s)/, "west")
    .replace(/\bn\b(?=\s)/, "north")
    .replace(/\bs\b(?=\s)/, "south")
    .replace(/\bavenue\b/, "ave")
    .replace(/\bstreet\b/, "st")
    .replace(/\broad\b/, "rd")
    .replace(/\bdrive\b/, "dr")
    .replace(/\bboulevard\b/, "blvd")
    .replace(/\bcourt\b/, "ct");
  return PINS[key] ?? null;
}
