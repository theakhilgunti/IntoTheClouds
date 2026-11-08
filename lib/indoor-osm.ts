/**
 * OSM Simple Indoor: fetch indoor=room|corridor|area rings near a building and
 * overlay them onto an estimated BuildingModel when enough rooms hit the footprint.
 */
import type { BuildingModel, Point, RoomType } from "@/packages/schema/building-model";
import { toLocal, type LatLng } from "./geo";
import { signedArea } from "./outline";
import { overlayIndoorOnModel as overlayLite, type IndoorRoomLite } from "./indoor-overlay";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = "CloudScan-HackRPI/0.1 (hackathon project)";

export type IndoorRoom = {
  id: number;
  name: string;
  type: RoomType;
  /** OSM level tag parsed to integer when possible; default 0. */
  level: number;
  /** Ring in meters relative to the search origin. */
  ring: Point[];
};

function parseLevel(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const first = raw.split(";")[0]?.split(",")[0]?.trim() ?? "0";
  const n = Number(first);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function roomTypeFromTags(tags: Record<string, string> | undefined): RoomType {
  const indoor = (tags?.indoor ?? "").toLowerCase();
  const room = (tags?.room ?? tags?.highway ?? "").toLowerCase();
  if (indoor === "corridor" || room === "corridor") return "hallway";
  if (room === "toilet" || room === "toilets" || room === "bathroom" || room === "bath") return "bathroom";
  if (room === "office" || room === "meeting_room") return "office";
  if (room === "stairs" || room === "staircase" || indoor === "stairs") return "stair";
  if (room === "kitchen") return "kitchen";
  if (room === "bedroom" || room === "hotel_room" || room === "dormitory") return "bedroom";
  if (room === "storage" || room === "utility") return "utility";
  return "other";
}

function roomName(tags: Record<string, string> | undefined, type: RoomType, id: number): string {
  if (tags?.name) return tags.name;
  if (tags?.ref) return `Room ${tags.ref}`;
  if (type === "hallway") return "Corridor";
  if (type === "bathroom") return "Restroom";
  if (type === "stair") return "Stairs";
  if (type === "office") return "Office";
  if (type === "bedroom") return "Room";
  return `Indoor ${id}`;
}

function closeRing(pts: Point[]): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return pts.slice(0, -1);
  return pts;
}

/** Overpass query for Simple Indoor ways around a point. */
export async function fetchIndoorRooms(origin: LatLng, radius = 60): Promise<IndoorRoom[]> {
  const q = `[out:json][timeout:20];
(
  way["indoor"~"^(room|corridor|area|level)$"](around:${radius},${origin.lat},${origin.lng});
  way["room"](around:${radius},${origin.lat},${origin.lng});
);
out tags geom;`;
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const out: IndoorRoom[] = [];
      for (const e of j.elements as Array<{
        type: string;
        id: number;
        tags?: Record<string, string>;
        geometry?: { lat: number; lon: number }[];
      }>) {
        if (e.type !== "way" || !e.geometry || e.geometry.length < 3) continue;
        if (e.tags?.indoor === "level") continue;
        const ring = closeRing(e.geometry.map((g) => toLocal(origin, { lat: g.lat, lng: g.lon })));
        if (ring.length < 3 || Math.abs(signedArea(ring)) < 0.5) continue;
        const type = roomTypeFromTags(e.tags);
        out.push({
          id: e.id,
          name: roomName(e.tags, type, e.id),
          type,
          level: parseLevel(e.tags?.level),
          ring,
        });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("OSM indoor fetch failed", lastErr);
  return [];
}

/** Shift indoor rings so they sit in the same local frame as the model footprint. */
export function shiftIndoorRooms(rooms: IndoorRoom[], originShift: Point): IndoorRoom[] {
  const [ox, oy] = originShift;
  return rooms.map((r) => ({
    ...r,
    ring: r.ring.map(([x, y]) => [x - ox, y - oy] as Point),
  }));
}

export type IndoorOverlayResult = {
  model: BuildingModel;
  used: number;
  note: string;
};

/**
 * When enough indoor rooms overlap the footprint, replace estimated room polygons
 * on matching floors. Keep template stairs/exits when indoor has no stair geometry.
 */
export function overlayIndoorOnModel(
  model: BuildingModel,
  rooms: IndoorRoom[],
  opts?: { minRooms?: number },
): IndoorOverlayResult | null {
  const lite = overlayLite(
    model as unknown as Parameters<typeof overlayLite>[0],
    rooms as IndoorRoomLite[],
    opts,
  );
  if (!lite) return null;
  return {
    model: lite.model as unknown as BuildingModel,
    used: lite.used,
    note: lite.note,
  };
}
