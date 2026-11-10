/**
 * Lot / site colors: blueprint (tactical cyan) vs realistic (Maps-style terrain).
 * No aerial imagery — solid / vertex-tinted materials only.
 */
import type { CompoundFeature } from "@/packages/schema/building-model";

export type SiteKind = CompoundFeature["kind"];

/** Blueprint / cyanotype tactical palette (existing look). */
export const SITE_COLOR_BLUEPRINT: Record<SiteKind, string> = {
  yard: "#14439c",
  driveway: "#3a68c4",
  patio: "#4a78d0",
  pool: "#6fa0ff",
  garage: "#2a5ab8",
  shed: "#2a5ab8",
  fence: "#9ebcff",
  trees: "#2f6bd0",
  road: "#0a2a68",
  signal: "#facc15",
  stop: "#ef4444",
  hydrant: "#dc2626",
  neighbor: "#8eb0e8",
  steps: "#c5d6f4",
  terrain: "#123a8a",
};

/**
 * Soft real-world lot palette for Realistic / terrain-mode fallback.
 * Roads read as asphalt; terrain as olive ground (no cyan bleed).
 */
export const SITE_COLOR_REALISTIC: Record<SiteKind, string> = {
  yard: "#3a5536",
  driveway: "#6a6d74",
  patio: "#8a8680",
  pool: "#3d7ea6",
  garage: "#7a7d84",
  shed: "#6e655c",
  fence: "#9a9590",
  trees: "#2a4528",
  road: "#2e3138",
  signal: "#facc15",
  stop: "#ef4444",
  hydrant: "#dc2626",
  neighbor: "#8b9098",
  steps: "#a8a49c",
  terrain: "#4a5c40",
};

/** Canvas / wrap sky when Realistic (never blueprint cyan). */
export const TERRAIN_SKY = "#1c2836" as const;

/** Soft ground disc under the house when DEM is absent or as underlay. */
export const SOFT_GROUND = {
  realistic: "#3f5240",
  blueprint: "#0f3a8e",
} as const;

/** Height-tint stops for DEM hillshade (low → high), Maps terrain vibe. */
export const DEM_HILLSHADE = {
  low: "#3a4f36",
  mid: "#5a6e4e",
  high: "#8a8670",
} as const;

export function siteColor(kind: SiteKind, realistic: boolean): string {
  return (realistic ? SITE_COLOR_REALISTIC : SITE_COLOR_BLUEPRINT)[kind];
}

/** Hover lighten for realistic site features (subtle). */
export function siteHover(kind: SiteKind, realistic: boolean): string {
  if (!realistic) {
    const map: Partial<Record<SiteKind, string>> = {
      neighbor: "#c5d6f4",
      steps: "#eaf1ff",
      trees: "#6fa0ff",
      stop: "#f87171",
      hydrant: "#f87171",
    };
    return map[kind] ?? "#cfdcf6";
  }
  const map: Partial<Record<SiteKind, string>> = {
    yard: "#4a6844",
    driveway: "#7a7d84",
    road: "#3e4148",
    neighbor: "#9aa0a8",
    trees: "#3a5c36",
    steps: "#b8b4ac",
    stop: "#f87171",
    hydrant: "#f87171",
    terrain: "#5a6e50",
  };
  return map[kind] ?? "#9aa39a";
}

/** Lerp hex colors (0–1). */
function lerpHex(a: string, b: string, t: number): [number, number, number] {
  const parse = (h: string) => {
    const n = h.replace("#", "");
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)] as const;
  };
  const A = parse(a);
  const B = parse(b);
  const u = Math.min(1, Math.max(0, t));
  return [
    (A[0] + (B[0] - A[0]) * u) / 255,
    (A[1] + (B[1] - A[1]) * u) / 255,
    (A[2] + (B[2] - A[2]) * u) / 255,
  ];
}

/**
 * Maps-style DEM tint from relative height (meters vs slab).
 * Returns RGB 0–1 triples suitable for THREE.BufferAttribute colors.
 */
export function demHillshadeRgb(relY: number, minY: number, maxY: number): [number, number, number] {
  const span = Math.max(0.4, maxY - minY);
  const t = (relY - minY) / span;
  if (t < 0.45) return lerpHex(DEM_HILLSHADE.low, DEM_HILLSHADE.mid, t / 0.45);
  return lerpHex(DEM_HILLSHADE.mid, DEM_HILLSHADE.high, (t - 0.45) / 0.55);
}
