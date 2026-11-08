/**
 * Soft typology check: compare an assumed layout fingerprint to a small public
 * plan-statistics bank. Never claims the bank entry is this address's real plan.
 *
 * Bank bands are mirrored in data/plan-fingerprints.json (hand-derived from public
 * residential / multi-unit plan statistics — not address-geocoded).
 */
import type { BuildingUse } from "./layout-use";

export type PlanFingerprint = {
  program: BuildingUse;
  bedrooms: number;
  baths: number;
  corridorFrac: number;
  aspect: number;
};

export type BankEntry = {
  program: BuildingUse | string;
  bedrooms: [number, number];
  baths: [number, number];
  corridorFrac: [number, number];
  aspect: [number, number];
  medianBays: number;
};

/** Compact typology bank (same content as data/plan-fingerprints.json). */
export const PLAN_FINGERPRINT_BANK: BankEntry[] = [
  { program: "house", bedrooms: [2, 4], baths: [1, 3], corridorFrac: [0.04, 0.16], aspect: [0.65, 1.55], medianBays: 3 },
  { program: "apartments", bedrooms: [4, 24], baths: [0, 8], corridorFrac: [0.08, 0.22], aspect: [0.35, 2.8], medianBays: 4 },
  { program: "dormitory", bedrooms: [6, 40], baths: [1, 10], corridorFrac: [0.08, 0.24], aspect: [0.3, 3.0], medianBays: 5 },
  { program: "hotel", bedrooms: [6, 50], baths: [0, 6], corridorFrac: [0.08, 0.22], aspect: [0.3, 3.2], medianBays: 5 },
  { program: "hospital", bedrooms: [4, 40], baths: [0, 8], corridorFrac: [0.1, 0.28], aspect: [0.35, 3.0], medianBays: 5 },
  { program: "school", bedrooms: [0, 2], baths: [1, 8], corridorFrac: [0.08, 0.25], aspect: [0.4, 2.5], medianBays: 4 },
  { program: "office", bedrooms: [0, 1], baths: [1, 6], corridorFrac: [0.05, 0.2], aspect: [0.45, 2.2], medianBays: 3 },
  { program: "warehouse", bedrooms: [0, 0], baths: [0, 2], corridorFrac: [0.0, 0.08], aspect: [0.4, 2.5], medianBays: 2 },
  { program: "church", bedrooms: [0, 0], baths: [0, 2], corridorFrac: [0.05, 0.2], aspect: [0.5, 2.0], medianBays: 2 },
  { program: "commercial", bedrooms: [0, 1], baths: [0, 4], corridorFrac: [0.04, 0.18], aspect: [0.45, 2.2], medianBays: 3 },
];

type FloorLike = {
  level: number;
  rooms: { type: string; polygon: [number, number][] }[];
};

function polyArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

/** Count room mix + corridor fraction on above-ground floors. */
export function fingerprintLayout(floors: FloorLike[], program: BuildingUse, width: number, depth: number): PlanFingerprint {
  const above = floors.filter((f) => f.level >= 0);
  let bedrooms = 0;
  let baths = 0;
  let corridor = 0;
  let total = 0;
  for (const f of above) {
    for (const r of f.rooms) {
      const a = polyArea(r.polygon);
      total += a;
      if (r.type === "bedroom") bedrooms++;
      if (r.type === "bathroom") baths++;
      if (r.type === "hallway" || r.type === "stair") corridor += a;
    }
  }
  return {
    program,
    bedrooms,
    baths,
    corridorFrac: total > 0.1 ? corridor / total : 0,
    aspect: depth > 0.1 ? width / depth : 1,
  };
}

function bandDist(v: number, lo: number, hi: number): number {
  if (v >= lo && v <= hi) return 0;
  if (v < lo) return (lo - v) / Math.max(1, hi - lo || 1);
  return (v - hi) / Math.max(1, hi - lo || 1);
}

/** Distance of fingerprint to a bank band (0 = inside all bands). */
export function typologyDistance(fp: PlanFingerprint, entry: BankEntry): number {
  return (
    bandDist(fp.bedrooms, entry.bedrooms[0], entry.bedrooms[1]) +
    bandDist(fp.baths, entry.baths[0], entry.baths[1]) +
    bandDist(fp.corridorFrac, entry.corridorFrac[0], entry.corridorFrac[1]) * 2 +
    bandDist(fp.aspect, entry.aspect[0], entry.aspect[1])
  );
}

export type TypologyCheck = {
  ok: boolean;
  distance: number;
  note: string;
  /** Suggested bay/unit-row count when far from the bank median. */
  nudgeBays: number | null;
};

/**
 * Soft-check assumed layout vs public plan stats for this program.
 * Large distance → warn and optionally suggest median bay count.
 */
export function softCheckTypology(fp: PlanFingerprint): TypologyCheck {
  const entry =
    PLAN_FINGERPRINT_BANK.find((e) => e.program === fp.program) ??
    PLAN_FINGERPRINT_BANK.find((e) => e.program === "house");
  if (!entry) {
    return { ok: true, distance: 0, note: "No typology bank entry for this program.", nudgeBays: null };
  }
  const distance = typologyDistance(fp, entry);
  const ok = distance <= 1.25;
  if (ok) {
    return {
      ok: true,
      distance,
      note: "Typology check vs public plan stats: room mix looks plausible for this program.",
      nudgeBays: null,
    };
  }
  return {
    ok: false,
    distance,
    note: `Typology check vs public plan stats: assumed layout is unusually far from typical ${entry.program} room mixes (distance ${distance.toFixed(2)}).`,
    nudgeBays: entry.medianBays,
  };
}
