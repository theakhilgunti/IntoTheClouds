/** Satellite / aerial imagery. Esri World Imagery by default; optional Google Maps Static when keyed. */
import type { LatLng } from "./geo";

export type Image = { base64: string; mime: "image/jpeg" | "image/png" | "image/webp" };

/** Esri export pixel size — 1280 reads cleaner on roofs/grounds than 640. */
const AERIAL_PX = 1280;

function exportUrl(c: LatLng, halfSize: number, px = AERIAL_PX) {
  const dLat = halfSize / 111320;
  const dLng = halfSize / (111320 * Math.cos((c.lat * Math.PI) / 180));
  const bbox = [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat].join(",");
  return (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${px},${px}&format=jpg&f=image`
  );
}

/** Rough zoom so Google Static covers ~halfSize meters from center to edge. */
function zoomForHalfSize(halfSize: number): number {
  // At mid-latitudes, zoom 19 ≈ 40 m half-width; zoom 18 ≈ 80 m; zoom 17 ≈ 160 m.
  if (halfSize <= 45) return 19;
  if (halfSize <= 90) return 18;
  if (halfSize <= 160) return 17;
  return 16;
}

/**
 * Google Maps Static satellite (optional). Set GOOGLE_MAPS_API_KEY to cross-check Esri.
 * Returns null when the key is missing or the request fails.
 */
export async function googleSatelliteImage(c: LatLng, halfSize: number): Promise<Image | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const zoom = zoomForHalfSize(halfSize);
  // scale=2 → 1280×1280 effective for cleaner roof/ground drapes.
  const url =
    "https://maps.googleapis.com/maps/api/staticmap" +
    `?center=${c.lat},${c.lng}&zoom=${zoom}&size=640x640&scale=2&maptype=satellite&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return null;
    return { base64: buf.toString("base64"), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Square, north-up aerial photo centered on `c`, about `halfSize` meters from center to edge.
 * Esri's export sometimes returns HTTP 500 for tight crops (beyond the zoom it has cached there),
 * so we step out to wider views until one renders.
 */
export async function aerialImage(c: LatLng, halfSize: number): Promise<{ image: Image; halfSize: number }> {
  // Step outward until Esri has a cached tile; larger footprints need a wider first ask.
  // Prefer 1280px; fall back if Esri rejects the export size.
  const sizes = [halfSize, 60, 80, 110, 150, 200, 280].filter((s, i, a) => s >= halfSize * 0.95 && a.indexOf(s) === i);
  const pixels = [AERIAL_PX, 1024, 640];
  let lastErr: unknown;
  for (const size of sizes) {
    for (const px of pixels) {
      try {
        const res = await fetch(exportUrl(c, size, px), { signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 2000) throw new Error("empty image");
        return { image: { base64: buf.toString("base64"), mime: "image/jpeg" }, halfSize: size };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}
