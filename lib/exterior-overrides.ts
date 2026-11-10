/**
 * Per-address exterior curation for demo / pinned houses.
 * Keys match lib/pins.ts normalization (house number + street).
 */
import type { FacadePreset } from "@/packages/schema/building-model";

export type ExteriorOverride = {
  /** Prefer Photorealistic 3D Tiles when the API key works. */
  preferTiles?: boolean;
  /** Default city-mesh opacity 0..1 when preferTiles and tiles are available. */
  tilesDefaultOpacity?: number;
  /** Force façade preset in terrain-style mode. */
  facadePreset?: FacadePreset;
  /** Human material label stored on model.exterior.material. */
  material?: string;
  /** Hide neighbor shells in the compound (cleaner demo framing). */
  hideNeighbors?: boolean;
};

function normalizeAddressKey(address?: string | null): string | null {
  const first = address?.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
  if (!first) return null;
  return first
    // Expand single-letter compass prefixes before street-type shorteners.
    .replace(/\be\b(?=\s)/, "east")
    .replace(/\bw\b(?=\s)/, "west")
    .replace(/\bn\b(?=\s)/, "north")
    .replace(/\bs\b(?=\s)/, "south")
    .replace(/\bavenue\b/, "ave")
    .replace(/\bstreet\b/, "st")
    .replace(/\broad\b/, "rd")
    .replace(/\bdrive\b/, "dr")
    .replace(/\bboulevard\b/, "blvd")
    .replace(/\bcourt\b/, "ct")
    .replace(/\bhall\b/, "hall");
}

/** Curated overrides for pitch / demo addresses. */
const OVERRIDES: Record<string, ExteriorOverride> = {
  "17 schuyler ave": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "vinyl",
    material: "vinyl siding",
    hideNeighbors: false,
  },
  "45 brunswick rd": {
    preferTiles: true,
    tilesDefaultOpacity: 0.88,
    facadePreset: "brick",
    material: "brick",
    hideNeighbors: false,
  },
  // BARH — Barton / residence hall on campus; soft concrete institutional look.
  barh: {
    preferTiles: true,
    tilesDefaultOpacity: 0.92,
    facadePreset: "concrete",
    material: "concrete",
    hideNeighbors: true,
  },
  "barh residence hall": {
    preferTiles: true,
    tilesDefaultOpacity: 0.92,
    facadePreset: "concrete",
    material: "concrete",
    hideNeighbors: true,
  },
  // East Hills (Loudonville / Colonie 12211) — curated from Street View vs scan (TEX-10).
  "3 east hills blvd": {
    preferTiles: true,
    tilesDefaultOpacity: 0.92,
    facadePreset: "brick",
    material: "brick with light siding",
    hideNeighbors: false,
  },
  "3 east hills boulevard": {
    preferTiles: true,
    tilesDefaultOpacity: 0.92,
    facadePreset: "brick",
    material: "brick with light siding",
    hideNeighbors: false,
  },
  "9 east hills blvd": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "brick",
    material: "brick",
    hideNeighbors: false,
  },
  "9 east hills boulevard": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "brick",
    material: "brick",
    hideNeighbors: false,
  },
  // Vinyl colonial on Andover / Brighton pocket (Street View).
  // OSM has no building for #1 — pin/scan lands on #2; same façade family.
  "1 andover dr": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "vinyl",
    material: "vinyl siding",
    hideNeighbors: false,
  },
  "2 andover dr": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "vinyl",
    material: "vinyl siding",
    hideNeighbors: false,
  },
  "3 andover dr": {
    preferTiles: true,
    tilesDefaultOpacity: 0.9,
    facadePreset: "vinyl",
    material: "vinyl siding",
    hideNeighbors: false,
  },
};

export function exteriorOverrideForAddress(address?: string | null): ExteriorOverride | null {
  const key = normalizeAddressKey(address);
  if (!key) return null;
  if (OVERRIDES[key]) return OVERRIDES[key];
  // Match BARH when address starts with barh or contains "barh".
  if (/\bbarh\b/.test(key)) return OVERRIDES.barh;
  return null;
}
