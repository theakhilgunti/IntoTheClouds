/**
 * CubiCasa5K-derived residential priors for estimated house layouts.
 *
 * CubiCasa5K (Kalervo et al., 2019) is ~5k annotated floor plans (mostly Finnish
 * residential). These numbers are hand-summarized room-mix / size bands from that
 * public dataset + paper — not geocoded to any address. Used only to make the
 * fallback "typical plan" less dumb when no verified plan / OSM indoor exists.
 *
 * Never treat these as this building's real floor plan.
 */

export type CubiCasaHousePrior = {
  targetBeds: number;
  targetBaths: number;
  /** Suggested depth bay / room-column count for planHouse. */
  bays: number;
  corridorFrac: [number, number];
  /** Rough living+dining share of above-ground floor area. */
  livingFrac: [number, number];
  note: string;
};

/**
 * Suggest bedroom/bath/bay targets from footprint area + stories.
 * Optional assessor beds/baths override when present.
 */
export function cubicasaHousePrior(
  footprintAreaM2: number,
  stories: number,
  bedsHint?: number | null,
  bathsHint?: number | null,
): CubiCasaHousePrior {
  const area = Math.max(20, footprintAreaM2);
  const levels = Math.max(1, Math.round(stories));
  const livingArea = area * levels;

  // CubiCasa5K residential plans skew compact; bands mirror common apartment/house mixes.
  let targetBeds: number;
  let targetBaths: number;
  let bays: number;
  if (livingArea < 70) {
    targetBeds = 1;
    targetBaths = 1;
    bays = 2;
  } else if (livingArea < 95) {
    targetBeds = 2;
    targetBaths = 1;
    bays = 2;
  } else if (livingArea < 130) {
    targetBeds = 3;
    targetBaths = 2;
    bays = 3;
  } else if (livingArea < 180) {
    targetBeds = 3;
    targetBaths = 2;
    bays = 3;
  } else {
    targetBeds = 4;
    targetBaths = 2;
    bays = 4;
  }

  if (bedsHint != null && bedsHint >= 1 && bedsHint <= 6) {
    targetBeds = Math.round(bedsHint);
    bays = Math.max(2, Math.min(4, targetBeds <= 2 ? 2 : targetBeds === 3 ? 3 : 4));
  }
  if (bathsHint != null && bathsHint >= 1 && bathsHint <= 4) {
    targetBaths = Math.round(bathsHint);
  } else if (targetBeds >= 3 && targetBaths < 2) {
    targetBaths = 2;
  }

  return {
    targetBeds,
    targetBaths,
    bays,
    corridorFrac: [0.05, 0.14],
    livingFrac: [0.2, 0.35],
    note:
      `CubiCasa5K-style prior (~${Math.round(livingArea)} m² living): ` +
      `~${targetBeds} bed / ${targetBaths} bath, ${bays} bay plan — statistical, not this address.`,
  };
}

/** Typology bank bands for house, sourced from CubiCasa5K residential room mixes. */
export const CUBICASA_HOUSE_BANK = {
  program: "house" as const,
  bedrooms: [1, 5] as [number, number],
  baths: [1, 3] as [number, number],
  corridorFrac: [0.04, 0.16] as [number, number],
  aspect: [0.55, 1.75] as [number, number],
  medianBays: 3,
  source: "CubiCasa5K residential room-mix summary (not address-geocoded)",
};
