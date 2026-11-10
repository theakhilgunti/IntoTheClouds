import { describe, expect, it } from "vitest";
import type { BuildingModel } from "../packages/schema/building-model.ts";
import { featureCenterline, findAlphaEntry, planHoseLays } from "./hose-lay.ts";

/** Minimal house: south wall has the front exit; road ribbon along the south street. */
function synthModel(opts?: {
  hydrants?: Array<{ id: string; x: number; y: number }>;
  road?: boolean;
  entryMarker?: [number, number];
}): BuildingModel {
  const hydrants = opts?.hydrants ?? [
    { id: "hydrant-0", x: -8, y: -16 },
    { id: "hydrant-1", x: 40, y: -16 },
  ];
  const features = [];
  if (opts?.road !== false) {
    // Ribbon [aL, bL, bR, aR] for a street along y = -14 from x=-30..50, width ~8.
    features.push({
      id: "road-0",
      kind: "road" as const,
      label: "Main St",
      polygon: [
        [-30, -10],
        [50, -10],
        [50, -18],
        [-30, -18],
      ],
      height: 0.05,
      source: "map" as const,
    });
  }
  for (const h of hydrants) {
    const s = 0.45;
    features.push({
      id: h.id,
      kind: "hydrant" as const,
      label: "Fire hydrant",
      polygon: [
        [h.x - s, h.y - s],
        [h.x + s, h.y - s],
        [h.x + s, h.y + s],
        [h.x - s, h.y + s],
      ],
      height: 0.85,
      source: "map" as const,
    });
  }

  const markers = opts?.entryMarker
    ? [
        {
          id: "entry-1",
          type: "entry" as const,
          floor: 0,
          pos: opts.entryMarker,
          note: "",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]
    : [];

  return {
    id: "hose-test",
    source: "demo",
    confidence: 1,
    address: "1 Test Lane",
    lat: 0,
    lng: 0,
    footprint: [
      [-5, -6],
      [5, -6],
      [5, 6],
      [-5, 6],
    ],
    floors: [
      {
        level: 0,
        name: "Ground",
        elevation: 0,
        height: 2.7,
        rooms: [
          {
            id: "r0",
            name: "Hall",
            type: "hallway",
            polygon: [
              [-4, -5],
              [4, -5],
              [4, 5],
              [-4, 5],
            ],
          },
        ],
        walls: [
          { id: "w-south", a: [-5, -6], b: [5, -6], thickness: 0.15, exterior: true },
          { id: "w-north", a: [-5, 6], b: [5, 6], thickness: 0.15, exterior: true },
        ],
        doors: [
          { id: "g-d-front", wallId: "w-south", t: 0.5, width: 0.9, exit: true },
          { id: "g-d-back", wallId: "w-north", t: 0.5, width: 0.9, exit: true },
        ],
        stairs: [],
      },
    ],
    markers,
    compound: { features, basis: "test" },
  };
}

describe("planHoseLays", () => {
  it("ranks the nearer hydrant first when a road exists", () => {
    const lays = planHoseLays(synthModel());
    expect(lays.length).toBe(2);
    expect(lays[0]!.rank).toBe(0);
    expect(lays[1]!.rank).toBe(1);
    expect(lays[0]!.hydrantId).toBe("hydrant-0");
    expect(lays[0]!.lengthM).toBeLessThan(lays[1]!.lengthM);
    // Path should use the road (more than 2 points) rather than a pure diagonal.
    expect(lays[0]!.path.length).toBeGreaterThan(2);
  });

  it("falls back to a straight hydrant→entry line when no roads", () => {
    const lays = planHoseLays(synthModel({ road: false }));
    expect(lays.length).toBe(2);
    const best = lays[0]!;
    expect(best.path.length).toBe(2);
    expect(best.path[0]).toEqual(best.hydrantPos);
    expect(best.path[1]).toEqual(best.entryPos);
    const straight = Math.hypot(
      best.hydrantPos[0] - best.entryPos[0],
      best.hydrantPos[1] - best.entryPos[1],
    );
    expect(best.lengthM).toBeCloseTo(straight, 5);
  });

  it("assigns loadHint thresholds from lengthM", () => {
    // Near hydrant (~8–10 m) → 200ft load.
    const short = planHoseLays(
      synthModel({
        hydrants: [{ id: "hydrant-near", x: 0, y: -12 }],
        road: false,
      }),
    );
    expect(short[0]!.loadHint).toBe("200ft");
    expect(short[0]!.lengthM).toBeLessThanOrEqual(61);

    // Mid distance ~75 m → 300ft load.
    const mid = planHoseLays(
      synthModel({
        hydrants: [{ id: "hydrant-mid", x: 0, y: -80 }],
        road: false,
        entryMarker: [0, -6],
      }),
    );
    expect(mid[0]!.lengthM).toBeGreaterThan(61);
    expect(mid[0]!.lengthM).toBeLessThanOrEqual(91);
    expect(mid[0]!.loadHint).toBe("300ft");

    // Long stretch > 91 m.
    const long = planHoseLays(
      synthModel({
        hydrants: [{ id: "hydrant-far", x: 0, y: -120 }],
        road: false,
        entryMarker: [0, -6],
      }),
    );
    expect(long[0]!.lengthM).toBeGreaterThan(91);
    expect(long[0]!.loadHint).toBe("long");
  });

  it("respects maxHydrants and prefers an entry marker for Alpha", () => {
    const model = synthModel({
      entryMarker: [2, -8],
      hydrants: [
        { id: "hydrant-0", x: -8, y: -16 },
        { id: "hydrant-1", x: 40, y: -16 },
        { id: "hydrant-2", x: 80, y: -16 },
      ],
    });
    expect(findAlphaEntry(model)).toEqual([2, -8]);
    const top = planHoseLays(model, { maxHydrants: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]!.entryPos).toEqual([2, -8]);
    expect(top[0]!.lengthFt).toBeCloseTo(top[0]!.lengthM * 3.280839895, 5);
  });

  it("extracts a ribbon centerline from a 4-gon road", () => {
    const cl = featureCenterline([
      [-30, -10],
      [50, -10],
      [50, -18],
      [-30, -18],
    ]);
    expect(cl).toHaveLength(2);
    expect(cl[0]![1]).toBeCloseTo(-14, 5);
    expect(cl[1]![1]).toBeCloseTo(-14, 5);
  });
});
