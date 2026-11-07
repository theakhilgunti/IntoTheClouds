/** Free aerial imagery (Esri World Imagery). Attribution: Esri, Maxar, Earthstar Geographics. */
import type { LatLng } from "@/lib/geo";

export type Image = { base64: string; mime: "image/jpeg" | "image/png" | "image/webp" };

function exportUrl(c: LatLng, halfSize: number) {
  const dLat = halfSize / 111320;
  const dLng = halfSize / (111320 * Math.cos((c.lat * Math.PI) / 180));
  const bbox = [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat].join(",");
  return (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=640,640&format=jpg&f=image`
  );
}

/**
 * Square, north-up aerial photo centered on `c`, about `halfSize` meters from center to edge.
 * Esri's export sometimes returns HTTP 500 for tight crops (beyond the zoom it has cached there),
 * so we step out to wider views until one renders.
 */
export async function aerialImage(c: LatLng, halfSize: number): Promise<Image> {
  const sizes = [halfSize, 60, 80, 110].filter((s, i, a) => s >= halfSize && a.indexOf(s) === i);
  let lastErr: unknown;
  for (const size of sizes) {
    try {
      const res = await fetch(exportUrl(c, size), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) throw new Error("empty image");
      return { base64: buf.toString("base64"), mime: "image/jpeg" };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
