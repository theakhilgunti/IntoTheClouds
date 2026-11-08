/**
 * Outdoor elevation: sample a DEM around the house and return heights relative to the slab.
 * Prefers OpenTopoData batch (NED 10 m in the US); falls back to USGS EPQS point queries.
 */
import { fromLocal, type LatLng } from "./geo";
import type { Point } from "@/packages/schema/building-model";
import type { DemGrid, LotGrade } from "./compound-geom";
import { geoCacheKey, ttlGet, ttlSet } from "./ttl-cache";

export type { DemGrid };

const UA = "CloudScan-HackRPI/0.1 (hackathon project)";
const OPENTOPO = "https://api.opentopodata.org/v1";
/** Free OpenTopoData allows ≤100 locations per request. */
const BATCH = 100;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOpenTopoBatch(points: LatLng[], dataset: string): Promise<(number | null)[]> {
  if (!points.length) return [];
  const out: (number | null)[] = new Array(points.length).fill(null);
  for (let start = 0; start < points.length; start += BATCH) {
    if (start > 0) await sleep(1050); // free tier ~1 req/s
    const slice = points.slice(start, start + BATCH);
    const locs = slice.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join("|");
    const url = `${OPENTOPO}/${dataset}?locations=${encodeURIComponent(locs)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`OpenTopo ${dataset} HTTP ${res.status}`);
    const j = (await res.json()) as { status?: string; results?: Array<{ elevation: number | null }> };
    if (j.status && j.status !== "OK") throw new Error(`OpenTopo ${dataset}: ${j.status}`);
    const results = j.results ?? [];
    slice.forEach((_, i) => {
      const e = results[i]?.elevation;
      out[start + i] = e != null && Number.isFinite(e) ? e : null;
    });
  }
  return out;
}

async function fetchEpqsPoint(p: LatLng): Promise<number | null> {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${p.lng}&y=${p.lat}&wkid=4326&units=Meters&includeDate=false`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { value?: number | string } | number;
    const raw = typeof j === "number" ? j : j?.value;
    const n = typeof raw === "string" ? parseFloat(raw) : raw;
    return n != null && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function fillMissingWithEpqs(points: LatLng[], elev: (number | null)[]): Promise<(number | null)[]> {
  const out = [...elev];
  const missing = points.map((p, i) => (out[i] == null ? i : -1)).filter((i) => i >= 0);
  // Cap EPQS fan-out — slow one-point API.
  const cap = missing.slice(0, 24);
  for (let i = 0; i < cap.length; i += 6) {
    const batch = cap.slice(i, i + 6);
    const got = await Promise.all(batch.map((ix) => fetchEpqsPoint(points[ix])));
    got.forEach((e, j) => {
      if (e != null) out[batch[j]] = e;
    });
  }
  return out;
}

function bilinearAt(abs: number[], cols: number, rows: number, cell: number, x0: number, y0: number, mx: number, my: number) {
  const u = (mx - x0) / cell;
  const v = (my - y0) / cell;
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(u)));
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(v)));
  const tx = Math.max(0, Math.min(1, u - c0));
  const ty = Math.max(0, Math.min(1, v - r0));
  const i = (c: number, r: number) => abs[r * cols + c];
  return (i(c0, r0) * (1 - tx) + i(c0 + 1, r0) * tx) * (1 - ty) + (i(c0, r0 + 1) * (1 - tx) + i(c0 + 1, r0 + 1) * tx) * ty;
}

/**
 * Sample a square DEM around the model origin (house slab). Returns relative heights
 * (slab ≈ 0). On failure returns null so the caller can keep the mild plane grade.
 */
export async function fetchSiteDem(opts: {
  /** Geographic position of model (0,0) — usually the building centroid. */
  geoOrigin: LatLng;
  /** Half-width of the square sample in model meters. */
  halfExtentM: number;
  /** Grid spacing in meters. */
  cellM?: number;
}): Promise<DemGrid | null> {
  // Aim for ≤ ~169 samples (~2 OpenTopo batches) so free-tier rate limits stay short.
  const half = Math.max(40, opts.halfExtentM);
  const targetCols = 13;
  const autoCell = Math.ceil((2 * half) / (targetCols - 1));
  const cell = Math.max(18, Math.min(40, opts.cellM ?? autoCell));
  const demKey = `${geoCacheKey(opts.geoOrigin.lat, opts.geoOrigin.lng)}|${Math.round(half)}|${cell}`;
  const cached = ttlGet<DemGrid>("site-dem", demKey);
  if (cached) return cached;
  const cols = Math.floor((2 * half) / cell) + 1;
  const rows = cols;
  const x0 = -half;
  const y0 = -half;

  const localPts: Point[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      localPts.push([x0 + c * cell, y0 + r * cell]);
    }
  }
  const geoPts = localPts.map((p) => fromLocal(opts.geoOrigin, p));

  let elev: (number | null)[] | null = null;
  let source = "opentopo-ned10m";
  try {
    elev = await fetchOpenTopoBatch(geoPts, "ned10m");
  } catch (e) {
    console.warn("OpenTopo ned10m failed", e);
  }
  const coverage = elev ? elev.filter((e) => e != null).length / elev.length : 0;
  if (!elev || coverage < 0.4) {
    try {
      elev = await fetchOpenTopoBatch(geoPts, "mapzen");
      source = "opentopo-mapzen";
    } catch (e) {
      console.warn("OpenTopo mapzen failed", e);
    }
  }
  if (!elev) elev = geoPts.map(() => null);
  // Skip slow per-point EPQS when OpenTopo already covered most of the grid.
  const openCoverage = elev.filter((e) => e != null).length / Math.max(1, elev.length);
  const filled = openCoverage >= 0.55 ? elev : await fillMissingWithEpqs(geoPts, elev);
  const usable = filled.map((e, i) => e ?? elev![i]);
  const ok = usable.filter((e) => e != null) as number[];
  if (ok.length < Math.max(4, usable.length * 0.35)) {
    console.warn("DEM sample too sparse", ok.length, "/", usable.length);
    return null;
  }

  // Fill remaining holes with nearest OK value.
  const abs: number[] = usable.map((e, i) => {
    if (e != null) return e;
    let best = ok[0];
    let bestD = Infinity;
    for (let j = 0; j < usable.length; j++) {
      if (usable[j] == null) continue;
      const d = Math.hypot(localPts[i][0] - localPts[j][0], localPts[i][1] - localPts[j][1]);
      if (d < bestD) {
        bestD = d;
        best = usable[j] as number;
      }
    }
    return best;
  });

  // Relative to house slab at model (0,0).
  const zSlab = bilinearAt(abs, cols, rows, cell, x0, y0, 0, 0);

  let rel = abs.map((z) => z - zSlab);
  // Reject wild spikes (bad tiles / water voids).
  const sorted = [...rel].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  rel = rel.map((z) => (Math.abs(z - med) > 120 ? med : z));

  const usedEpqs = filled.some((e, i) => e != null && elev![i] == null);
  if (source.startsWith("opentopo") && usedEpqs) {
    source = `${source}+epqs`;
  } else if (ok.length && elev.every((e) => e == null)) {
    source = "usgs-epqs";
  }

  const grid: DemGrid = { x0, y0, cell, cols, rows, z: rel, source };
  ttlSet("site-dem", demKey, grid);
  return grid;
}

/** Attach a DEM grid onto a plane grade (plane remains the fallback outside / if dem missing). */
export function withDem(grade: LotGrade | null, dem: DemGrid | null): LotGrade | null {
  if (!grade && !dem) return null;
  const base: LotGrade = grade ?? {
    downhill: [0, -1],
    slope: 0.02,
    origin: [0, 0],
  };
  if (!dem) return base;
  return { ...base, dem };
}
