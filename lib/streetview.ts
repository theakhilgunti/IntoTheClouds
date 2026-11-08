/**
 * Google Street View for exterior cross-check (facade, stories, garage, entry).
 * Uses the same GOOGLE_MAPS_API_KEY as Static satellite. Soft evidence — never overrides a clear map outline.
 */
import { bearing, fromLocal, type LatLng } from "./geo";
import type { Point } from "@/packages/schema/building-model";
import type { Image } from "./imagery";
import { facadeHeadings } from "./streetview-cues";

export {
  facadeHeadings,
  frontDoorFractionFromFacade,
  mergeGarageCue,
  mergeStoriesCue,
  nudgeRoomBays,
} from "./streetview-cues";

export type StreetViewShot = {
  image: Image;
  heading: number;
  label: string;
};

export type StreetViewBundle = {
  shots: StreetViewShot[];
  pano: LatLng;
  lookHeading: number;
  status: "used" | "skipped" | "failed";
  detail: string;
};

type MetaOk = {
  status: "OK";
  location: LatLng;
  pano_id?: string;
  date?: string;
};

function mapsKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY || undefined;
}

export function streetViewAvailable(): boolean {
  return !!mapsKey();
}

async function fetchMetadata(at: LatLng, key: string): Promise<MetaOk | null> {
  const url =
    "https://maps.googleapis.com/maps/api/streetview/metadata" +
    `?location=${at.lat},${at.lng}&source=outdoor&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      status?: string;
      location?: { lat: number; lng: number };
      pano_id?: string;
      date?: string;
    };
    if (j.status !== "OK" || j.location == null) return null;
    if (!Number.isFinite(j.location.lat) || !Number.isFinite(j.location.lng)) return null;
    return {
      status: "OK",
      location: { lat: j.location.lat, lng: j.location.lng },
      pano_id: j.pano_id,
      date: j.date,
    };
  } catch {
    return null;
  }
}

async function fetchStatic(opts: {
  key: string;
  location: LatLng;
  heading: number;
  pitch?: number;
  fov?: number;
}): Promise<Image | null> {
  const pitch = opts.pitch ?? 2;
  const fov = opts.fov ?? 80;
  const url =
    "https://maps.googleapis.com/maps/api/streetview" +
    `?size=640x640&location=${opts.location.lat},${opts.location.lng}` +
    `&heading=${opts.heading.toFixed(1)}&pitch=${pitch}&fov=${fov}` +
    `&source=outdoor&return_error_code=true&key=${encodeURIComponent(opts.key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2500) return null;
    return { base64: buf.toString("base64"), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/** Probe a few meters toward the street so metadata prefers a road pano over a driveway dead-end. */
export function streetViewProbe(building: LatLng, streetDir: Point | null | undefined): LatLng {
  if (!streetDir) return building;
  const len = Math.hypot(streetDir[0], streetDir[1]) || 1;
  return fromLocal(building, [(streetDir[0] / len) * 18, (streetDir[1] / len) * 18]);
}

/**
 * Fetch outdoor Street View shots looking at the building from the nearest road pano.
 * Returns status skipped when the key is missing, or failed/empty when coverage is absent.
 */
export async function fetchStreetViewFacade(
  building: LatLng,
  opts?: { streetDir?: Point | null },
): Promise<StreetViewBundle> {
  const key = mapsKey();
  if (!key) {
    return {
      shots: [],
      pano: building,
      lookHeading: 0,
      status: "skipped",
      detail: "No GOOGLE_MAPS_API_KEY — Street View exterior check skipped.",
    };
  }

  const probe = streetViewProbe(building, opts?.streetDir);
  let meta = await fetchMetadata(probe, key);
  if (!meta) meta = await fetchMetadata(building, key);
  if (!meta) {
    return {
      shots: [],
      pano: building,
      lookHeading: 0,
      status: "failed",
      detail: "No outdoor Street View coverage near this address.",
    };
  }

  const pano = meta.location;
  const lookHeading = bearing(pano, building);
  const headings = facadeHeadings(lookHeading);
  const labels = ["Facade · Street View", "Facade left · Street View", "Facade right · Street View"];
  const shots: StreetViewShot[] = [];
  for (let i = 0; i < headings.length; i++) {
    const image = await fetchStatic({ key, location: pano, heading: headings[i], pitch: i === 0 ? 4 : 2, fov: i === 0 ? 75 : 85 });
    if (image) shots.push({ image, heading: headings[i], label: labels[i] });
  }

  if (!shots.length) {
    return {
      shots: [],
      pano,
      lookHeading,
      status: "failed",
      detail: "Street View metadata OK but static images failed.",
    };
  }

  const when = meta.date ? ` · imagery ${meta.date}` : "";
  return {
    shots,
    pano,
    lookHeading,
    status: "used",
    detail: `${shots.length} outdoor facade shot(s) from the nearest road panorama${when}.`,
  };
}
