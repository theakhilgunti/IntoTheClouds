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
  /** Parking lots / parking aisles as closed rings when mapped. */
  parking: Point[][];
  /** Road centerlines near the house, in meters from the search point. */
  roads: { name: string | null; pts: Point[] }[];
  /** Mapped fire hydrants near the house (local meters). */
  hydrants: Point[];
  /** Mapped tree trunks / tree-row samples near the house (local meters). */
  trees: Point[];
};

const NON_HOUSE = new Set(["garage", "garages", "shed", "roof", "carport", "service", "hut", "cabin", "greenhouse", "barn"]);

const UA = "CloudScan-HackRPI/0.1 (hackathon project)";
const ROADS = /^(residential|service|tertiary|secondary|primary|unclassified|living_street|trunk)$/;

function isHydrantTags(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return tags.emergency === "fire_hydrant" || tags.amenity === "fire_hydrant";
}

function isTreeNodeTags(tags: Record<string, string> | undefined): boolean {
  return tags?.natural === "tree";
}

function isTreeRowTags(tags: Record<string, string> | undefined): boolean {
  return tags?.natural === "tree_row";
}

/** Sample points along a polyline every ~spacing meters (includes endpoints). */
function samplePolyline(pts: Point[], spacing = 4): Point[] {
  if (pts.length === 0) return [];
  const out: Point[] = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = dist(a, b);
    if (seg < 1e-6) continue;
    let t = spacing - carry;
    while (t < seg) {
      const u = t / seg;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      t += spacing;
    }
    carry = (carry + seg) % spacing;
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (dist(prev, last) > 0.5) out.push(last);
  return out;
}

type OsmFetch = { ways: OsmWay[]; hydrants: Point[]; trees: Point[] };

/** Main OpenStreetMap API: everything in a small box around the point. Fast and reliable for tiny areas. */
async function fromOsmApi(o: LatLng, radius: number): Promise<OsmFetch> {
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
  const hydrants: Point[] = [];
  const trees: Point[] = [];
  for (const e of j.elements) {
    if (e.type !== "node") continue;
    nodes.set(e.id, { lat: e.lat, lon: e.lon });
    const tags = e.tags as Record<string, string> | undefined;
    if (isHydrantTags(tags)) {
      hydrants.push(toLocal(o, { lat: e.lat, lng: e.lon }));
    }
    if (isTreeNodeTags(tags)) {
      trees.push(toLocal(o, { lat: e.lat, lng: e.lon }));
    }
  }
  const ways: OsmWay[] = [];
  for (const e of j.elements) {
    if (e.type !== "way" || !e.tags) continue;
    const tags = e.tags as Record<string, string>;
    const barrier = tags.barrier && /^(fence|wall|hedge)$/.test(tags.barrier);
    const pool = tags.leisure === "swimming_pool";
    const parking = tags.amenity === "parking" || tags.leisure === "parking";
    const treeRow = isTreeRowTags(tags);
    if (!tags.building && !(tags.highway && ROADS.test(tags.highway)) && !barrier && !pool && !parking && !treeRow) continue;
    const geometry = (e.nodes as number[]).map((id) => nodes.get(id)).filter(Boolean) as { lat: number; lon: number }[];
    if (treeRow && geometry.length >= 2) {
      const local = geometry.map((g) => toLocal(o, { lat: g.lat, lng: g.lon }));
      trees.push(...samplePolyline(local, 4));
      continue;
    }
    ways.push({ id: e.id, tags: e.tags, geometry });
  }
  return { ways, hydrants, trees };
}

/** Try the main OSM API first, then the Overpass mirrors. */
async function fetchMap(origin: LatLng, overpassQuery: string, radius = 150): Promise<OsmFetch> {
  try {
    return await fromOsmApi(origin, radius);
  } catch (e) {
    console.warn("OSM API failed, trying Overpass", e);
    return runQuery(origin, overpassQuery);
  }
}

/** Dedicated hydrant node query — OSM map bbox often misses street hydrants past ~150 m. */
async function fetchHydrantsOverpass(origin: LatLng, radius: number): Promise<Point[]> {
  const q = `[out:json][timeout:20];
(
  node["emergency"="fire_hydrant"](around:${radius},${origin.lat},${origin.lng});
  node["amenity"="fire_hydrant"](around:${radius},${origin.lat},${origin.lng});
);
out body;`;
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
      const out: Point[] = [];
      for (const e of j.elements as Array<{ type: string; lat?: number; lon?: number; tags?: Record<string, string> }>) {
        if (e.type === "node" && e.lat != null && e.lon != null && isHydrantTags(e.tags)) {
          out.push(toLocal(origin, { lat: e.lat, lng: e.lon }));
        }
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function runQuery(origin: LatLng, query: string): Promise<OsmFetch> {
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
      const ways: OsmWay[] = [];
      const hydrants: Point[] = [];
      const trees: Point[] = [];
      for (const e of j.elements as Array<{
        type: string;
        id: number;
        tags?: Record<string, string>;
        lat?: number;
        lon?: number;
        geometry?: { lat: number; lon: number }[];
      }>) {
        if (e.type === "node" && e.lat != null && e.lon != null) {
          if (isHydrantTags(e.tags)) hydrants.push(toLocal(origin, { lat: e.lat, lng: e.lon }));
          if (isTreeNodeTags(e.tags)) trees.push(toLocal(origin, { lat: e.lat, lng: e.lon }));
        } else if (e.type === "way" && e.geometry) {
          if (isTreeRowTags(e.tags)) {
            const local = e.geometry.map((g) => toLocal(origin, { lat: g.lat, lng: g.lon }));
            trees.push(...samplePolyline(local, 4));
          } else {
            ways.push({ id: e.id, tags: e.tags, geometry: e.geometry });
          }
        }
      }
      return { ways, hydrants, trees };
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
  // Wide enough for a full house lot / small campus; denser cities still stay under Overpass limits.
  // Hydrants need extra reach — street corners are often >150 m from the geocode point.
  const R = 220;
  const HYDRANT_R = 320;
  const q = `[out:json][timeout:25];
(
  way["building"](around:${R},${origin.lat},${origin.lng});
  way["highway"~"^(residential|service|tertiary|secondary|primary|unclassified|living_street|trunk)$"](around:${R},${origin.lat},${origin.lng});
  way["barrier"~"^(fence|wall|hedge)$"](around:${R},${origin.lat},${origin.lng});
  way["leisure"="swimming_pool"](around:${R},${origin.lat},${origin.lng});
  way["amenity"="parking"](around:${R},${origin.lat},${origin.lng});
  way["leisure"="parking"](around:${R},${origin.lat},${origin.lng});
  way["natural"="tree_row"](around:${R},${origin.lat},${origin.lng});
  node["natural"="tree"](around:${R},${origin.lat},${origin.lng});
  node["emergency"="fire_hydrant"](around:${HYDRANT_R},${origin.lat},${origin.lng});
  node["amenity"="fire_hydrant"](around:${HYDRANT_R},${origin.lat},${origin.lng});
);
out tags geom;`;
  // OSM map API bbox uses R; hydrant nodes farther out are filled in by Overpass when needed.
  const { ways: els, hydrants: apiHydrants, trees: apiTrees } = await fetchMap(origin, q, R);
  let rawHydrants = apiHydrants;
  let rawTrees = [...apiTrees];
  // OSM map bbox (R) often misses the nearest street hydrants past ~150–200 m — always merge Overpass.
  try {
    const extra = await fetchHydrantsOverpass(origin, HYDRANT_R);
    const seen = new Set(rawHydrants.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`));
    for (const p of extra) {
      const key = `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      if (!seen.has(key)) {
        seen.add(key);
        rawHydrants.push(p);
      }
    }
  } catch (e) {
    console.warn("Hydrant Overpass supplement failed", e);
  }

  const buildings: OsmBuilding[] = [];
  const roads: { name: string | null; pts: Point[] }[] = [];
  const fences: Point[][] = [];
  const pools: Point[][] = [];
  const parking: Point[][] = [];
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
    } else if (w.tags?.amenity === "parking" || w.tags?.leisure === "parking") {
      const ring = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
      if (ring.length >= 3) parking.push(ring);
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

  // All mapped hydrants in range (beacons render every one kept on the scene).
  const hydrants = rawHydrants
    .map((p) => ({ p, d: dist(here, p) }))
    .filter((h) => h.d < HYDRANT_R)
    .sort((a, b) => a.d - b.d)
    .slice(0, 40)
    .map((h) => h.p);

  const seenTree = new Set<string>();
  const trees = rawTrees
    .map((p) => ({ p, d: dist(here, p) }))
    .filter((t) => t.d < R)
    .sort((a, b) => a.d - b.d)
    .filter((t) => {
      const key = `${t.p[0].toFixed(1)},${t.p[1].toFixed(1)}`;
      if (seenTree.has(key)) return false;
      seenTree.add(key);
      return true;
    })
    .slice(0, 60)
    .map((t) => t.p);

  return {
    building, chosenBy, buildingCount: buildings.length, nearby, roadDir, roadName, roadDistance,
    structures: buildings, fences, pools, parking, roads, hydrants, trees,
  };
}
