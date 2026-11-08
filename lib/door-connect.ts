/**
 * Ensure every interior room gets a door onto the connected graph.
 * Pure helpers (node:test friendly) — used by layout placeDoors.
 *
 * Opening policy (realistic adjacency):
 * - bedroom↔bedroom / private↔private: no opening
 * - bathroom: door only to hall / stair / ensuite bedroom / utility / closet
 * - living / kitchen / dining (and hall into them): open archways (no door leaf)
 */

export type ConnectWall = {
  id: string;
  exterior: boolean;
  zones: [string, string | null];
  length: number;
  a?: [number, number];
  b?: [number, number];
};

export type OpeningKind = "none" | "door" | "open";

export type ConnectDoor = {
  wallId: string;
  width: number;
  exit: boolean;
  t: number;
  kind?: "door" | "open";
};

const ENTRY_HINTS = ["hall", "lobby", "narthex", "corridor", "base"];

const GENERAL = new Set(["living", "kitchen", "dining"]);
const CIRC = new Set(["hallway", "stair"]);
const PRIVATE = new Set(["bedroom", "office"]);

/** Prefer circulation rooms as the BFS start. */
export function pickStartZone(zones: string[], preferred?: string[] | null): string | null {
  if (preferred) {
    for (const z of preferred) if (zones.includes(z)) return z;
  }
  for (const z of zones) {
    const low = z.toLowerCase();
    if (ENTRY_HINTS.some((h) => low === h || low.endsWith(`-${h}`) || low.includes(`-${h}`))) return z;
  }
  return zones[0] ?? null;
}

/** Walls that touch both zones (interior only), longest first. */
export function wallsBetween(walls: ConnectWall[], z1: string, z2: string, minLen: number): ConnectWall[] {
  return walls
    .filter((w) => !w.exterior && w.length >= minLen && w.zones.includes(z1) && w.zones.includes(z2))
    .sort((a, b) => b.length - a.length);
}

/** Any interior wall that borders this zone (other side must be another zone). */
export function wallsTouching(walls: ConnectWall[], zone: string, minLen: number): ConnectWall[] {
  return walls
    .filter((w) => !w.exterior && w.length >= minLen && w.zones.includes(zone) && w.zones[1] != null)
    .sort((a, b) => b.length - a.length);
}

export type RoomPoly = { zone: string; poly: [number, number][] };

function centroid(poly: [number, number][]): [number, number] {
  let x = 0, y = 0;
  for (const p of poly) {
    x += p[0];
    y += p[1];
  }
  const n = Math.max(1, poly.length);
  return [x / n, y / n];
}

function dist2(a: [number, number], b: [number, number]) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** Closest points between two rings (vertex–vertex; good enough for door synthesis). */
export function closestPoints(
  a: [number, number][],
  b: [number, number][],
): { pa: [number, number]; pb: [number, number]; d: number } {
  let best = { pa: a[0], pb: b[0], d: Infinity };
  for (const pa of a) {
    for (const pb of b) {
      const d = Math.sqrt(dist2(pa, pb));
      if (d < best.d) best = { pa, pb, d };
    }
  }
  return best;
}

/** Infer a room type from an explicit map or zone/id naming hints. */
export function inferRoomType(zoneId: string, typed?: string | null): string {
  if (typed) return typed;
  const z = zoneId.toLowerCase();
  if (/(^|[-_])bed(room)?s?($|[-_])|bedroom/.test(z)) return "bedroom";
  if (/(bath|restroom|wc|toilet)/.test(z)) return "bathroom";
  if (/(kitchen|kitc)/.test(z)) return "kitchen";
  if (/(dining|diner)/.test(z)) return "dining";
  if (/(living|lounge|great|family)/.test(z)) return "living";
  if (/(hall|corridor|lobby|narthex|foyer)/.test(z)) return "hallway";
  if (/(closet|wardrobe|storage)/.test(z)) return "closet";
  if (/(office|study|den)/.test(z)) return "office";
  if (/garage/.test(z)) return "garage";
  if (/(util|laundry|mud)/.test(z)) return "utility";
  if (/stair/.test(z)) return "stair";
  return "other";
}

/**
 * Decide whether adjacent rooms get a hinged door, an open arch, or nothing.
 * Connectivity rescue may still force a door when a room would otherwise stay sealed.
 */
export function openingBetween(typeA: string, typeB: string): OpeningKind {
  const a = typeA;
  const b = typeB;
  if (a === b) {
    if (a === "bedroom" || a === "bathroom" || a === "office" || a === "closet") return "none";
    if (GENERAL.has(a) || CIRC.has(a)) return "open";
    return "door";
  }

  // Bathrooms keep real doors, and only to sensible neighbors — not every shared wall.
  if (a === "bathroom" || b === "bathroom") {
    const other = a === "bathroom" ? b : a;
    if (
      other === "hallway" ||
      other === "stair" ||
      other === "bedroom" ||
      other === "utility" ||
      other === "closet"
    ) {
      return "door";
    }
    return "none";
  }

  // Private rooms do not interconnect (use the hall instead).
  if (PRIVATE.has(a) && PRIVATE.has(b)) return "none";

  if (a === "closet" || b === "closet") return "door";

  // Living / kitchen / dining among themselves or into circulation → open entrance.
  if ((GENERAL.has(a) || CIRC.has(a)) && (GENERAL.has(b) || CIRC.has(b))) return "open";

  // Other rooms opening onto living / kitchen / dining are usually cased openings.
  if (GENERAL.has(a) || GENERAL.has(b)) return "open";

  if (CIRC.has(a) || CIRC.has(b)) return "door";

  if (a === "garage" || b === "garage" || a === "utility" || b === "utility") return "door";

  return "door";
}

function openingWidth(kind: "door" | "open", wallLen: number): number {
  if (kind === "open") return Math.min(1.85, Math.max(1.15, wallLen * 0.42));
  return Math.min(0.95, Math.max(0.7, Math.min(0.85, wallLen - 0.12)));
}

/**
 * BFS door placement from circulation, rescue on short edges, then synthesize a
 * short interior wall+door into any room that is still sealed (common after clip gaps).
 * Extra illicit openings respect room-type adjacency (no bedroom↔bedroom, open into living, etc.).
 */
export function connectZonesWithDoors(
  walls: ConnectWall[],
  zones: string[],
  opts?: {
    minLen?: number;
    rescueLen?: number;
    preferredStart?: string[] | null;
    roomPolys?: RoomPoly[] | null;
    /** zone id → RoomType (or string). Missing keys are inferred from the id. */
    roomTypes?: Record<string, string> | null;
  },
): { doors: ConnectDoor[]; reached: Set<string>; extraWalls: ConnectWall[] } {
  const minLen = opts?.minLen ?? 0.55;
  const rescueLen = opts?.rescueLen ?? 0.25;
  const doors: ConnectDoor[] = [];
  const usedWalls = new Set<string>();
  const extraWalls: ConnectWall[] = [];
  const mutableWalls = [...walls];
  const types = opts?.roomTypes ?? {};

  const typeOf = (z: string) => inferRoomType(z, types[z] ?? null);
  const policy = (z0: string, z1: string) => openingBetween(typeOf(z0), typeOf(z1));

  const addOpening = (w: ConnectWall, kind: OpeningKind, force = false) => {
    if (usedWalls.has(w.id)) return false;
    let effective: "door" | "open";
    if (kind === "none") {
      if (!force) return false;
      effective = "door";
    } else {
      effective = kind;
    }
    usedWalls.add(w.id);
    doors.push({
      wallId: w.id,
      width: openingWidth(effective, w.length),
      exit: false,
      t: 0.5,
      kind: effective,
    });
    return true;
  };

  /** Rank candidate walls for growing into a sealed zone (lower = better). */
  const rankWall = (w: ConnectWall, sealed: string) => {
    const other = w.zones[0] === sealed ? w.zones[1] : w.zones[0];
    if (!other) return 100;
    const k = policy(sealed, other);
    if (k === "none") return 50 - w.length * 0.01;
    if (k === "door" && (typeOf(other) === "hallway" || typeOf(other) === "stair")) return 0 - w.length;
    if (k === "open") return 5 - w.length * 0.1;
    return 10 - w.length * 0.1;
  };

  const start = pickStartZone(zones, opts?.preferredStart);
  const reached = new Set<string>(start ? [start] : []);

  const grow = (len: number) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const z of zones) {
        if (reached.has(z)) continue;
        const options = [...reached]
          .flatMap((r) => wallsBetween(mutableWalls, z, r, len))
          .sort((a, b) => rankWall(a, z) - rankWall(b, z));
        // Prefer policy-allowed openings; force only if nothing allowed reaches the graph.
        const allowed = options.filter((w) => {
          const other = w.zones[0] === z ? w.zones[1] : w.zones[0];
          return other != null && policy(z, other) !== "none";
        });
        const pick = allowed[0] ?? options[0];
        if (!pick) continue;
        const other = pick.zones[0] === z ? pick.zones[1] : pick.zones[0];
        const kind = other ? policy(z, other) : "door";
        if (addOpening(pick, kind, kind === "none")) {
          reached.add(z);
          changed = true;
        }
      }
    }
  };

  grow(minLen);
  grow(rescueLen);

  // Open any remaining interior adjacency into sealed rooms.
  let guard = 0;
  while (guard++ < zones.length + 2) {
    const sealed = zones.filter((z) => !reached.has(z));
    if (!sealed.length) break;
    let progressed = false;
    for (const z of sealed) {
      const toReached = wallsTouching(mutableWalls, z, rescueLen)
        .filter((w) => {
          const other = w.zones[0] === z ? w.zones[1] : w.zones[0];
          return other != null && reached.has(other);
        })
        .sort((a, b) => rankWall(a, z) - rankWall(b, z));
      const pick =
        toReached[0] ??
        wallsTouching(mutableWalls, z, Math.max(0.15, rescueLen * 0.5)).sort(
          (a, b) => rankWall(a, z) - rankWall(b, z),
        )[0];
      if (!pick) continue;
      const other = pick.zones[0] === z ? pick.zones[1] : pick.zones[0];
      const kind = other ? policy(z, other) : "door";
      if (!addOpening(pick, kind, true)) continue;
      reached.add(z);
      if (other) reached.add(other);
      progressed = true;
      break;
    }
    if (!progressed) break;
    grow(rescueLen);
  }

  // Synthesize a short wall+door from each sealed room toward the nearest reached room.
  const polys = opts?.roomPolys ?? [];
  const polyOf = (z: string) => polys.find((p) => p.zone === z)?.poly;
  guard = 0;
  while (guard++ < zones.length + 2) {
    const sealed = zones.filter((z) => !reached.has(z));
    if (!sealed.length) break;
    let progressed = false;
    for (const z of sealed) {
      const poly = polyOf(z);
      if (!poly || poly.length < 3) continue;
      const cz = centroid(poly);
      let best: { r: string; hit: ReturnType<typeof closestPoints>; score: number } | null = null;
      for (const r of reached) {
        const rp = polyOf(r);
        if (!rp || rp.length < 3) continue;
        const hit = closestPoints(poly, rp);
        const k = policy(z, r);
        const score = hit.d + (k === "none" ? 20 : k === "open" ? 0 : 2);
        if (!best || score < best.score) best = { r, hit, score };
      }
      if (!best || best.hit.d > 8) {
        // Fall back: door on longest exterior wall of this room (opening toward start).
        const ext = mutableWalls
          .filter((w) => w.exterior && w.zones[0] === z && w.length >= 0.8)
          .sort((a, b) => b.length - a.length)[0];
        if (ext && addOpening(ext, "door", true)) {
          // Reclassify as a passable opening even on the shell — better than a sealed pocket.
          ext.exterior = false;
          if (start) ext.zones = [z, start];
          reached.add(z);
          progressed = true;
          break;
        }
        continue;
      }
      const { pa, pb } = best.hit;
      // Build a short door segment between the two rooms (or on the sealed room face).
      let a: [number, number] = pa;
      let b: [number, number] = pb;
      if (best.hit.d < 0.05) {
        // Already touching at a point — invent a 0.9 m segment along the sealed boundary near pa.
        const i = poly.findIndex((p) => p[0] === pa[0] && p[1] === pa[1]);
        const j = i >= 0 ? (i + 1) % poly.length : 0;
        const p0 = poly[i >= 0 ? i : 0];
        const p1 = poly[j];
        const edgeLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        const ux = (p1[0] - p0[0]) / edgeLen;
        const uy = (p1[1] - p0[1]) / edgeLen;
        const half = Math.min(0.45, edgeLen * 0.35);
        a = [pa[0] - ux * half, pa[1] - uy * half];
        b = [pa[0] + ux * half, pa[1] + uy * half];
      }
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.4) {
        const c = centroid(polyOf(best.r)!);
        const dirx = c[0] - cz[0];
        const diry = c[1] - cz[1];
        const dl = Math.hypot(dirx, diry) || 1;
        const px = -diry / dl;
        const py = dirx / dl;
        a = [cz[0] + (dirx / dl) * 0.2 - px * 0.45, cz[1] + (diry / dl) * 0.2 - py * 0.45];
        b = [cz[0] + (dirx / dl) * 0.2 + px * 0.45, cz[1] + (diry / dl) * 0.2 + py * 0.45];
      }
      const wallLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const id = `synth-${z}-${best.r}`;
      const synth: ConnectWall = {
        id,
        exterior: false,
        zones: [z, best.r],
        length: Math.max(0.85, wallLen),
        a,
        b,
      };
      mutableWalls.push(synth);
      extraWalls.push(synth);
      const kind = policy(z, best.r);
      if (addOpening(synth, kind, true)) {
        reached.add(z);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
    grow(rescueLen);
  }

  // Selective illicit openings: punch through shared partitions when policy allows
  // (open into living/kitchen/dining; hinged doors to halls; never bedroom↔bedroom).
  for (const w of mutableWalls) {
    if (w.exterior) continue;
    const z0 = w.zones[0];
    const z1 = w.zones[1];
    if (!z0 || !z1 || z0 === z1) continue;
    if (w.length < 0.5) continue;
    if (usedWalls.has(w.id)) continue;
    const kind = policy(z0, z1);
    if (kind === "none") continue;
    if (addOpening(w, kind)) {
      reached.add(z0);
      reached.add(z1);
    }
  }

  // Near-miss shell walls against another room — only when policy allows an opening.
  for (const w of mutableWalls) {
    if (!w.exterior || !w.a || !w.b || w.length < 0.75) continue;
    if (usedWalls.has(w.id)) continue;
    const z0 = w.zones[0];
    if (!z0) continue;
    const mid: [number, number] = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const wl = w.length || 1;
    const nx = -(w.b[1] - w.a[1]) / wl;
    const ny = (w.b[0] - w.a[0]) / wl;
    let neighbor: string | null = null;
    let bestSep = Infinity;
    for (const other of polys) {
      if (other.zone === z0) continue;
      const c = centroid(other.poly);
      const sep = Math.abs((c[0] - mid[0]) * nx + (c[1] - mid[1]) * ny);
      const along =
        (c[0] - mid[0]) * ((w.b[0] - w.a[0]) / wl) + (c[1] - mid[1]) * ((w.b[1] - w.a[1]) / wl);
      if (sep > 1.25 || Math.abs(along) > wl * 0.65) continue;
      if (sep < bestSep) {
        bestSep = sep;
        neighbor = other.zone;
      }
    }
    if (!neighbor) continue;
    const kind = policy(z0, neighbor);
    if (kind === "none") continue;
    w.exterior = false;
    w.zones = [z0, neighbor];
    if (addOpening(w, kind)) {
      reached.add(z0);
      reached.add(neighbor);
    }
  }

  // Final sweep: any room still without a doorway gets one forced synth cut
  // (prefer a policy-friendly neighbor).
  for (const z of zones) {
    const hasDoor = doors.some((d) => {
      const w = mutableWalls.find((x) => x.id === d.wallId);
      return w?.zones.includes(z);
    });
    if (hasDoor) continue;
    const poly = polyOf(z);
    if (!poly || poly.length < 3) continue;
    let best: { r: string; hit: ReturnType<typeof closestPoints>; score: number } | null = null;
    for (const r of zones) {
      if (r === z) continue;
      const rp = polyOf(r);
      if (!rp) continue;
      const hit = closestPoints(poly, rp);
      const k = policy(z, r);
      const score = hit.d + (k === "none" ? 25 : 0);
      if (!best || score < best.score) best = { r, hit, score };
    }
    if (!best || best.hit.d > 14) continue;
    const cz = centroid(poly);
    const cr = centroid(polyOf(best.r)!);
    const dirx = cr[0] - cz[0];
    const diry = cr[1] - cz[1];
    const dl = Math.hypot(dirx, diry) || 1;
    const px = -diry / dl;
    const py = dirx / dl;
    const a: [number, number] = [
      cz[0] + (dirx / dl) * 0.15 - px * 0.45,
      cz[1] + (diry / dl) * 0.15 - py * 0.45,
    ];
    const b: [number, number] = [
      cz[0] + (dirx / dl) * 0.15 + px * 0.45,
      cz[1] + (diry / dl) * 0.15 + py * 0.45,
    ];
    const id = `illicit-${z}-${best.r}`;
    const synth: ConnectWall = {
      id,
      exterior: false,
      zones: [z, best.r],
      length: Math.hypot(b[0] - a[0], b[1] - a[1]),
      a,
      b,
    };
    mutableWalls.push(synth);
    extraWalls.push(synth);
    const kind = policy(z, best.r);
    if (addOpening(synth, kind, true)) reached.add(z);
  }

  return { doors, reached, extraWalls };
}
