/** OpenStreetMap Overpass: building outlines + tags and nearby roads around a point. */
import {
  angleDiff, bearing, dist, distToRing, fromLocal, nearestOnSegment, pointInPolygon, polygonArea, polygonCentroid, toLocal,
  type LatLng,
} from "./geo";
import type { Point } from "@/packages/schema/building-model";
import { normStreet, parseStreetAddress, streetsMatch } from "./address";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

type OsmWay = { id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] };

export type OsmBuilding = {
  id: number;
  tags: Record<string, string>;
  /** Outline in meters relative to the search origin. */
  ring: Point[];
  area: number;
};

export type NearbyHouse = { id: number; label: string };

export type OsmContext = {
  building: OsmBuilding | null;
  chosenBy: "address-tag" | "geocoder-building" | "contains-point" | "in-view-direction" | "nearest" | "none";
  buildingCount: number;
  /** Other addressed buildings close enough that the user can switch if we picked the neighbor. */
  nearby: NearbyHouse[];
  /** Unit vector (local frame) from the building toward the nearest road, if any road was found. */
  roadDir: Point | null;
  roadName: string | null;
  roadDistance: number | null;
  /** Every mapped building in the box, including garages and sheds. Coordinates are relative to the search point. */
  structures: OsmBuilding[];
  /** Fence, wall, and hedge centerlines. */
  fences: Point[][];
  /** Mapped swimming pools. */
  pools: Point[][];
  /** Road centerlines near the house, in meters from the search point. */
  roads: { name: string | null; pts: Point[] }[];
};

const NON_HOUSE = new Set(["garage", "garages", "shed", "roof", "carport", "service", "hut", "cabin", "greenhouse", "barn"]);

const UA = "CloudScan-HackRPI/0.1 (hackathon project)";
const ROADS = /^(residential|service|tertiary|secondary|primary|unclassified|living_street|trunk)$/;

/** Main OpenStreetMap API: everything in a small box around the point. Fast and reliable for tiny areas. */
async function fromOsmApi(o: LatLng, radius: number): Promise<OsmWay[]> {
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos((o.lat * Math.PI) / 180));
  const bbox = [o.lng - dLng, o.lat - dLat, o.lng + dLng, o.lat + dLat].map((n) => n.toFixed(6)).join(",");
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`OSM API HTTP ${res.status}`);
  const j = await res.json();
  const nodes = new Map<number, { lat: number; lon: number }>();
  for (const e of j.elements) if (e.type === "node") nodes.set(e.id, { lat: e.lat, lon: e.lon });
  const ways: OsmWay[] = [];
  for (const e of j.elements) {
    if (e.type !== "way" || !e.tags) continue;
    const tags = e.tags as Record<string, string>;
    const barrier = tags.barrier && /^(fence|wall|hedge)$/.test(tags.barrier);
    const pool = tags.leisure === "swimming_pool";
    if (!tags.building && !(tags.highway && ROADS.test(tags.highway)) && !barrier && !pool) continue;
    const geometry = (e.nodes as number[]).map((id) => nodes.get(id)).filter(Boolean) as { lat: number; lon: number }[];
    ways.push({ id: e.id, tags: e.tags, geometry });
  }
  return ways;
}

/** Try the main OSM API first, then the Overpass mirrors. */
async function fetchWays(origin: LatLng, overpassQuery: string): Promise<OsmWay[]> {
  try {
    return await fromOsmApi(origin, 80);
  } catch (e) {
    console.warn("OSM API failed, trying Overpass", e);
    return runQuery(overpassQuery);
  }
}

async function runQuery(query: string): Promise<OsmWay[]> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return j.elements as OsmWay[];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export type AddressHint = {
  /** Street address as matched by the geocoder, e.g. "17 SCHUYLER AVE, LATHAM, NY". */
  address?: string | null;
  /** OSM way id of the building Nominatim says holds this address. */
  wayId?: number | null;
  /** User picked this outline. Do not override it with a different address tag. */
  force?: boolean;
};

function houseLabel(b: OsmBuilding): string {
  const num = b.tags["addr:housenumber"];
  const street = b.tags["addr:street"];
  return num && street ? `${num} ${street}` : `Building ${b.id}`;
}

/**
 * Find the house at `origin`. If `heading` (compass degrees the camera faced) is given and the point
 * is not inside any outline, prefer buildings in that direction.
 */
export async function lookupBuilding(origin: LatLng, heading?: number | null, hint?: AddressHint): Promise<OsmContext> {
  const q = `[out:json][timeout:20];
(
  way["building"](around:80,${origin.lat},${origin.lng});
  way["highway"~"^(residential|service|tertiary|secondary|primary|unclassified|living_street)$"](around:70,${origin.lat},${origin.lng});
  way["barrier"~"^(fence|wall|hedge)$"](around:70,${origin.lat},${origin.lng});
  way["leisure"="swimming_pool"](around:70,${origin.lat},${origin.lng});
);
out tags geom;`;
  const els = await fetchWays(origin, q);

  const buildings: OsmBuilding[] = [];
  const roads: { name: string | null; pts: Point[] }[] = [];
  const fences: Point[][] = [];
  const pools: Point[][] = [];
  for (const w of els) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const pts = w.geometry.map((g) => toLocal(origin, { lat: g.lat, lng: g.lon }));
    if (w.tags?.building) {
      const ring = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
      if (ring.length >= 3) buildings.push({ id: w.id, tags: w.tags, ring, area: polygonArea(ring) });
    } else if (w.tags?.highway) {
      roads.push({ name: w.tags.name ?? null, pts });
    } else if (w.tags?.leisure === "swimming_pool") {
      const ring = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
      if (ring.length >= 3) pools.push(ring);
    } else if (w.tags?.barrier) {
      fences.push(pts);
    }
  }

  const here: Point = [0, 0];
  const houses = buildings.filter((b) => !NON_HOUSE.has(b.tags.building) && b.area > 25);
  const pool = houses.length ? houses : buildings;

  let building: OsmBuilding | null = null;
  let chosenBy: OsmContext["chosenBy"] = "none";
  const want = parseStreetAddress(hint?.address);
  const tagged = want
    ? buildings.find((b) => {
        const n = b.tags["addr:housenumber"]?.toLowerCase();
        const st = b.tags["addr:street"];
        return n === want.num && !!st && streetsMatch(normStreet(st), want.street);
      })
    : undefined;
  const sameNumber = want
    ? buildings.filter((b) => b.tags["addr:housenumber"]?.toLowerCase() === want.num)
    : [];
  const byWay = hint?.wayId ? buildings.find((b) => b.id === hint.wayId) : undefined;
  const inside = pool.find((b) => pointInPolygon(here, b.ring));
  if (hint?.force && byWay) {
    building = byWay;
    chosenBy = "geocoder-building";
  } else if (tagged) {
    building = tagged;
    chosenBy = "address-tag";
  } else if (sameNumber.length === 1) {
    building = sameNumber[0];
    chosenBy = "address-tag";
  } else if (byWay) {
    building = byWay;
    chosenBy = "geocoder-building";
  } else if (inside) {
    building = inside;
    chosenBy = "contains-point";
  } else if (pool.length) {
    const scored = pool
      .map((b) => {
        const c = polygonCentroid(b.ring);
        const brg = bearing(origin, fromLocal(origin, c));
        return { b, d: distToRing(here, b.ring), off: heading != null ? angleDiff(brg, heading) : 0 };
      })
      .filter((s) => s.d < 60);
    if (heading != null) {
      const inView = scored.filter((s) => s.off <= 35).sort((a, b) => a.d - b.d)[0];
      if (inView) {
        building = inView.b;
        chosenBy = "in-view-direction";
      }
    }
    if (!building && scored.length) {
      building = scored.sort((a, b) => a.d - b.d)[0].b;
      chosenBy = "nearest";
    }
  }

  let roadDir: Point | null = null, roadName: string | null = null, roadDistance: number | null = null;
  if (roads.length) {
    const c = building ? polygonCentroid(building.ring) : here;
    let best = Infinity;
    for (const r of roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const n = nearestOnSegment(c, r.pts[i], r.pts[i + 1]);
        const d = dist(c, n);
        if (d < best) {
          best = d;
          roadDir = [(n[0] - c[0]) / (d || 1), (n[1] - c[1]) / (d || 1)];
          roadName = r.name;
          roadDistance = d;
        }
      }
    }
  }

  const nearby = buildings
    .filter((b) => b.tags["addr:housenumber"] && b.area > 25 && !NON_HOUSE.has(b.tags.building) && distToRing(here, b.ring) < 70)
    .map((b) => ({ id: b.id, label: houseLabel(b), d: distToRing(here, b.ring) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map(({ id, label }) => ({ id, label }));
  if (building && !nearby.some((n) => n.id === building!.id) && building.tags["addr:housenumber"]) {
    nearby.unshift({ id: building.id, label: houseLabel(building) });
  }

  return {
    building, chosenBy, buildingCount: buildings.length, nearby, roadDir, roadName, roadDistance,
    structures: buildings, fences, pools, roads,
  };
}
