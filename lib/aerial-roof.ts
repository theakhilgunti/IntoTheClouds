/**
 * Lightweight cues from an Esri aerial JPEG (no Gemini required).
 * Looks at the dark roof blob near the image center: shape guess + ridge bearing.
 */
import jpeg from "jpeg-js";
import type { Image } from "./imagery";

export type AerialRoofCue = {
  shape: "gable" | "hip" | "flat" | null;
  /** Degrees clockwise from north; null when unclear. */
  ridgeBearingDeg: number | null;
  confidence: number;
  note: string;
};

function lum(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Angle of the first principal axis of the mask, degrees clockwise from image +y (north-up → north). */
function maskBearing(xs: number[], ys: number[], w: number, h: number): number | null {
  if (xs.length < 40) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < xs.length; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= xs.length;
  my /= ys.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Image y grows south; convert eigenvector angle to compass bearing (0 = north).
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // radians, image frame (+x east, +y south)
  const east = Math.cos(theta);
  const south = Math.sin(theta);
  const north = -south;
  let bearing = (Math.atan2(east, north) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  // Prefer the direction closer to the longer image extent of the blob.
  void w;
  void h;
  return bearing;
}

/**
 * Decode the aerial and score the center roof. Safe to call with any JPEG; returns low confidence on failure.
 */
export function analyzeAerialRoof(image: Image): AerialRoofCue {
  try {
    if (image.mime !== "image/jpeg") {
      return { shape: null, ridgeBearingDeg: null, confidence: 0, note: "Aerial is not JPEG" };
    }
    const raw = jpeg.decode(Buffer.from(image.base64, "base64"), { useTArray: true, formatAsRGBA: true });
    const { width: w, height: h, data } = raw;
    if (w < 32 || h < 32) {
      return { shape: null, ridgeBearingDeg: null, confidence: 0, note: "Aerial too small" };
    }

    // Sample a center window (~40% of the frame) where the house usually sits.
    const x0 = Math.floor(w * 0.3);
    const x1 = Math.floor(w * 0.7);
    const y0 = Math.floor(h * 0.3);
    const y1 = Math.floor(h * 0.7);
    const vals: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        vals.push(lum(data[i], data[i + 1], data[i + 2]));
      }
    }
    vals.sort((a, b) => a - b);
    const p35 = vals[Math.floor(vals.length * 0.35)] ?? 128;
    const p60 = vals[Math.floor(vals.length * 0.6)] ?? 160;
    const threshold = (p35 + p60) / 2;

    const xs: number[] = [];
    const ys: number[] = [];
    let sum = 0;
    let sum2 = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const L = lum(data[i], data[i + 1], data[i + 2]);
        if (L > threshold) continue;
        xs.push(x);
        ys.push(y);
        sum += L;
        sum2 += L * L;
      }
    }
    if (xs.length < 80) {
      return { shape: null, ridgeBearingDeg: null, confidence: 0.1, note: "No clear roof blob in the aerial" };
    }

    const mean = sum / xs.length;
    const variance = Math.max(0, sum2 / xs.length - mean * mean);
    const std = Math.sqrt(variance);
    const bearing = maskBearing(xs, ys, w, h);

    // Aspect of the blob in image space.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      minX = Math.min(minX, xs[i]);
      maxX = Math.max(maxX, xs[i]);
      minY = Math.min(minY, ys[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);

    let shape: AerialRoofCue["shape"] = null;
    let confidence = 0.35;
    let note = "Aerial roof blob scored";
    if (std < 12 && aspect < 1.5) {
      shape = "flat";
      confidence = 0.45;
      note = "Aerial looks even and pad-like";
    } else if (aspect >= 1.4 && std >= 10) {
      shape = "gable";
      confidence = 0.5;
      note = "Aerial roof is elongated with shading variation";
    } else if (aspect < 1.35 && std >= 14) {
      shape = "hip";
      confidence = 0.4;
      note = "Aerial roof is compact with shading on multiple sides";
    } else if (aspect >= 1.35) {
      shape = "gable";
      confidence = 0.35;
      note = "Aerial roof is elongated";
    }

    return { shape, ridgeBearingDeg: bearing, confidence, note };
  } catch (e) {
    return {
      shape: null,
      ridgeBearingDeg: null,
      confidence: 0,
      note: `Aerial read failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}
