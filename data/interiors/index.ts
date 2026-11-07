/**
 * Verified interiors: real room layouts from a floor plan, survey or WiFi scan.
 * Key = the model id a scan produces (e.g. "osm-871876464"); value = a BuildingModel JSON whose
 * `interior` is { status: "verified", source: "..." }. Anything not listed here is reported as
 * "interior unknown, needs a scan" instead of being guessed.
 *
 * To add one: save the JSON next to this file, import it below, and add it to the map.
 */
const INTERIORS: Record<string, unknown> = {};

export default INTERIORS;
