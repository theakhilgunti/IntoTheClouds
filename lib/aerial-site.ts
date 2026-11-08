/**
 * Lightweight site cues from an Esri / satellite JPEG (no Gemini required).
 * Finds dark paved ribbons (driveways), secondary dark rectangles (likely garages),
 * and thin dark/green linear features (likely fences / hedges).
 */
import jpeg from "jpeg-js";
import type { Image } from "./imagery";
import type { CompoundKind } from "./compound-geom";
import { boxToPolygon, type Point } from "./compound-geom";

export type AerialSiteCue = {
  kind: CompoundKind;
  label: string;
  polygon: Point[];
  confidence: number;
};

function lum(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Green-ish vegetation (hedges) vs grey pavement. */
function greenness(r: number, g: number, b: number) {
  return g - (r + b) * 0.5;
}

/**
 * Scan the ring around the center house for paved / outbuilding blobs and map them
 * into model-frame polygons using the same 0..1000 → meters convention as Gemini boxes.
 */
export function analyzeAerialSite(image: Image, halfSize: number): AerialSiteCue[] {
  try {
    if (image.mime !== "image/jpeg" || halfSize < 8) return [];
    const raw = jpeg.decode(Buffer.from(image.base64, "base64"), { useTArray: true, formatAsRGBA: true });
    const { width: w, height: h, data } = raw;
    if (w < 48 || h < 48) return [];

    // Exclude the center house (~28% window); look at the surrounding ring.
    const cx0 = Math.floor(w * 0.36);
    const cx1 = Math.floor(w * 0.64);
    const cy0 = Math.floor(h * 0.36);
    const cy1 = Math.floor(h * 0.64);

    const vals: number[] = [];
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;
        const i = (y * w + x) * 4;
        vals.push(lum(data[i], data[i + 1], data[i + 2]));
      }
    }
    vals.sort((a, b) => a - b);
    const darkCut = vals[Math.floor(vals.length * 0.28)] ?? 90;
    const paveCut = vals[Math.floor(vals.length * 0.42)] ?? 110;

    type Cell = { x: number; y: number; v: number };
    const dark: Cell[] = [];
    const pave: Cell[] = [];
    const step = Math.max(2, Math.floor(Math.min(w, h) / 160));
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;
        const i = (y * w + x) * 4;
        const v = lum(data[i], data[i + 1], data[i + 2]);
        if (v <= darkCut) dark.push({ x, y, v });
        else if (v <= paveCut) pave.push({ x, y, v });
      }
    }

    const cues: AerialSiteCue[] = [];
    const garage = densestBlob(dark, w, h, 0.012, 0.08);
    if (garage) {
      const poly = boxToPolygon(
        {
          x0: (garage.minX / w) * 1000,
          y0: (garage.minY / h) * 1000,
          x1: (garage.maxX / w) * 1000,
          y1: (garage.maxY / h) * 1000,
        },
        halfSize,
      );
      if (poly) {
        cues.push({ kind: "garage", label: "Garage (aerial)", polygon: poly, confidence: garage.score });
      }
    }

    const drive = densestBlob(pave, w, h, 0.01, 0.12);
    if (drive) {
      const aspect = (drive.maxX - drive.minX + 1) / Math.max(1, drive.maxY - drive.minY + 1);
      // Driveways are elongated; skip blobby yards.
      if (aspect > 1.6 || aspect < 0.55) {
        const poly = boxToPolygon(
          {
            x0: (drive.minX / w) * 1000,
            y0: (drive.minY / h) * 1000,
            x1: (drive.maxX / w) * 1000,
            y1: (drive.maxY / h) * 1000,
          },
          halfSize,
        );
        if (poly) {
          cues.push({ kind: "driveway", label: "Driveway (aerial)", polygon: poly, confidence: drive.score * 0.85 });
        }
      }
    }

    const fenceCues = extractLinearFenceCues(data, w, h, halfSize, cx0, cx1, cy0, cy1);
    cues.push(...fenceCues);

    return cues.filter((c) => c.confidence >= 0.35).slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Thin dark or green ribbons outside the house — candidate fences / hedges.
 * Emits up to a few elongated boxes in the model frame.
 */
function extractLinearFenceCues(
  data: Uint8Array | Uint8ClampedArray | Buffer,
  w: number,
  h: number,
  halfSize: number,
  cx0: number,
  cx1: number,
  cy0: number,
  cy1: number,
): AerialSiteCue[] {
  const vals: number[] = [];
  const greens: number[] = [];
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;
      const i = (y * w + x) * 4;
      vals.push(lum(data[i], data[i + 1], data[i + 2]));
      greens.push(greenness(data[i], data[i + 1], data[i + 2]));
    }
  }
  if (vals.length < 40) return [];
  vals.sort((a, b) => a - b);
  greens.sort((a, b) => a - b);
  const darkCut = vals[Math.floor(vals.length * 0.22)] ?? 70;
  const greenCut = greens[Math.floor(greens.length * 0.72)] ?? 12;

  type Cell = { x: number; y: number };
  const cells: Cell[] = [];
  const step = Math.max(2, Math.floor(Math.min(w, h) / 180));
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const v = lum(r, g, b);
      const gn = greenness(r, g, b);
      if (v <= darkCut || gn >= greenCut) cells.push({ x, y });
    }
  }

  const out: AerialSiteCue[] = [];
  let remaining = cells;
  for (let n = 0; n < 5 && remaining.length >= 10; n++) {
    const blob = densestBlob(remaining.map((c) => ({ ...c, v: 0 })), w, h, 0.004, 0.06);
    if (!blob) break;
    const bw = blob.maxX - blob.minX;
    const bh = blob.maxY - blob.minY;
    const aspect = (bw + 1) / Math.max(1, bh + 1);
    // Fences/hedges are elongated; skip compact garage-like blobs.
    if (aspect < 1.8 && aspect > 1 / 1.8) {
      remaining = remaining.filter(
        (c) => !(c.x >= blob.minX - 4 && c.x <= blob.maxX + 4 && c.y >= blob.minY - 4 && c.y <= blob.maxY + 4),
      );
      continue;
    }
    const poly = boxToPolygon(
      {
        x0: (blob.minX / w) * 1000,
        y0: (blob.minY / h) * 1000,
        x1: (blob.maxX / w) * 1000,
        y1: (blob.maxY / h) * 1000,
      },
      halfSize,
    );
    if (poly) {
      out.push({
        kind: "fence",
        label: aspect >= 1.8 || aspect <= 1 / 1.8 ? "Fence / hedge (aerial)" : "Yard barrier (aerial)",
        polygon: poly,
        confidence: Math.min(0.8, blob.score * 0.95),
      });
    }
    remaining = remaining.filter(
      (c) => !(c.x >= blob.minX - 6 && c.x <= blob.maxX + 6 && c.y >= blob.minY - 6 && c.y <= blob.maxY + 6),
    );
  }
  return out;
}

function densestBlob(
  cells: { x: number; y: number; v: number }[],
  w: number,
  h: number,
  minFrac: number,
  maxFrac: number,
): { minX: number; maxX: number; minY: number; maxY: number; score: number } | null {
  if (cells.length < 12) return null;
  // Grid hash clustering: pick the cell with most neighbors in a local window.
  const key = (x: number, y: number) => `${Math.floor(x / 8)}_${Math.floor(y / 8)}`;
  const buckets = new Map<string, { x: number; y: number }[]>();
  for (const c of cells) {
    const k = key(c.x, c.y);
    const arr = buckets.get(k) ?? [];
    arr.push(c);
    buckets.set(k, arr);
  }
  let bestKey = "";
  let bestN = 0;
  for (const [k, arr] of buckets) {
    if (arr.length > bestN) {
      bestN = arr.length;
      bestKey = k;
    }
  }
  if (!bestKey || bestN < 6) return null;
  // Grow by absorbing adjacent buckets.
  const seed = new Set<string>([bestKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const k of [...seed]) {
      const [gx, gy] = k.split("_").map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nk = `${gx + dx}_${gy + dy}`;
          if (seed.has(nk)) continue;
          const arr = buckets.get(nk);
          if (arr && arr.length >= 3) {
            seed.add(nk);
            grew = true;
          }
        }
      }
    }
  }
  const pts: { x: number; y: number }[] = [];
  for (const k of seed) {
    const arr = buckets.get(k);
    if (arr) pts.push(...arr);
  }
  const frac = pts.length / ((w * h) / 64);
  if (frac < minFrac || frac > maxFrac) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < w * 0.04 || bh < h * 0.04) return null;
  const score = Math.min(0.85, 0.35 + frac * 4 + Math.min(bw, bh) / Math.max(w, h));
  return { minX, maxX, minY, maxY, score };
}
