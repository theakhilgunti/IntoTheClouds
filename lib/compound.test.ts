import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessFeatures,
  accessoryReach,
  assembleCompound,
  boxToPolygon,
  compoundReach,
  crossVerifySiteFeatures,
  foundationExtent,
  neighborReach,
  neighborShellHeight,
  pointInRing,
  ringSeparation,
  roomBays,
  siteHull,
} from "./compound-geom.ts";

describe("street and driveway", () => {
  it("counts one window-bay per four meters of depth", () => {
    assert.equal(roomBays(15.3), 4);
    assert.equal(roomBays(9), 2);
  });

  it("runs the driveway from the street to the garage, beside the house", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [{ name: "Simonson Avenue", pts: [[-20, -14], [20, -14]] }],
      garage: [[6, 4], [10, 4], [10, 8], [6, 8]],
    });
    const road = features.find((f) => f.kind === "road");
    const drive = features.find((f) => f.kind === "driveway");
    assert.equal(road?.label, "Simonson Avenue");
    assert.ok(drive);
    const midX = drive!.polygon.reduce((s, p) => s + p[0], 0) / drive!.polygon.length;
    assert.ok(midX > 4, `driveway should sit east of the house, was ${midX}`);
  });

  it("keeps a long road stretch plus a connector and a traffic light at the cross", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [
        { name: "Simonson Avenue", pts: [[-90, -14], [90, -14]] },
        { name: "Cross Street", pts: [[12, -80], [12, 80]] },
      ],
      garage: null,
    });
    const roads = features.filter((f) => f.kind === "road");
    assert.ok(roads.length >= 2, `expected main + connector, got ${roads.length}`);
    assert.ok(features.some((f) => f.kind === "signal"), "crossing should spawn a traffic light");
  });

  it("places the nearest mapped fire hydrants around the house", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [{ name: "Simonson Avenue", pts: [[-20, -14], [20, -14]] }],
      garage: null,
      hydrants: [
        [8, -12],
        [40, -10],
        [140, -20],
        [400, 0],
        [-6, -16],
      ],
    });
    const hydrants = features.filter((f) => f.kind === "hydrant");
    assert.ok(hydrants.length >= 4, `street hydrants ~140 m should stay, got ${hydrants.length}`);
    assert.equal(hydrants.length, 4, "400 m hydrant should be dropped");
    assert.equal(hydrants[0].label, "Nearest hydrant");
    const c0 = hydrants[0].polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    assert.ok(Math.hypot(c0[0] - 8, c0[1] + 12) < 0.5 || Math.hypot(c0[0] + 6, c0[1] + 16) < 0.5);
  });
});

describe("aerial boxes", () => {
  it("puts a centered box on the origin, east to the right and north up", () => {
    const poly = boxToPolygon({ x0: 375, y0: 375, x1: 625, y1: 625 }, 40);
    assert.ok(poly);
    assert.deepEqual(poly![0].map((n) => Math.round(n)), [-10, 10]);
    assert.deepEqual(poly![2].map((n) => Math.round(n)), [10, -10]);
  });

  it("drops a box that covers most of the photo", () => {
    assert.equal(boxToPolygon({ x0: 0, y0: 0, x1: 900, y1: 900 }, 40), null);
  });
});

describe("compound assembly", () => {
  const lot: [number, number][] = [[-8, -6], [12, -6], [12, 28], [-8, 28]];
  const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

  it("keeps the lot and a garage on it, and drops a garage on the next lot", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "garage", ring: [[6, 16], [11, 16], [11, 22], [6, 22]], area: 30 },
        { id: 3, tag: "garage", ring: [[30, 16], [36, 16], [36, 22], [30, 22]], area: 30 },
      ],
      fences: [[[-8, -6], [12, -6]]],
      pools: [],
      parcel: lot,
      aerial: [
        { kind: "patio", polygon: [[-4, 10], [2, 10], [2, 16], [-4, 16]] },
        { kind: "driveway", polygon: [[-2, -20], [3, -20], [3, -28], [-2, -28]] },
        { kind: "garage", label: "Aerial garage", polygon: [[6.5, 16.5], [10, 16.5], [10, 21], [6.5, 21]] },
      ],
    });
    assert.ok(features.some((f) => f.kind === "yard"));
    assert.equal(features.filter((f) => f.kind === "garage").length, 1);
    assert.equal(features.find((f) => f.kind === "garage")!.source, "map");
    assert.equal(features.filter((f) => f.kind === "patio").length, 1);
    assert.equal(features.filter((f) => f.kind === "driveway").length, 0);
    assert.ok(features.some((f) => f.kind === "fence"));
    assert.ok(pointInRing([0, 20], lot));
  });

  it("builds a site hull when there is no tax lot, and keeps a rear garage", () => {
    const bigHouse: [number, number][] = [[-20, -15], [20, -15], [20, 15], [-20, 15]];
    assert.ok(compoundReach(bigHouse) > 60);
    assert.ok(accessoryReach(bigHouse) < compoundReach(bigHouse));
    assert.ok(foundationExtent(bigHouse) > 20);
    const garage: [number, number][] = [[8, 40], [16, 40], [16, 50], [8, 50]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: bigHouse,
      structures: [
        { id: 1, tag: "yes", ring: bigHouse, area: 1200 },
        { id: 2, tag: "garage", ring: garage, area: 80 },
      ],
      fences: [],
      pools: [],
      parking: [[[-15, -30], [15, -30], [15, -22], [-15, -22]]],
      parcel: null,
      aerial: [],
    });
    assert.ok(features.some((f) => f.kind === "yard"));
    assert.ok(features.some((f) => f.kind === "garage"));
    assert.ok(features.some((f) => f.kind === "driveway" && f.label === "Parking"));
  });

  it("draws attached next-door houses as ghost neighbor shells, not garages", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const attached: [number, number][] = [[5, -4], [15, -4], [15, 4], [5, 4]];
    const far: [number, number][] = [[60, -4], [70, -4], [70, 4], [60, 4]];
    assert.ok(neighborReach(house) >= accessoryReach(house));
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "house", ring: attached, area: 80, levels: 2 },
        { id: 3, tag: "residential", ring: far, area: 90 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      mainEaveHeight: 5.4,
    });
    const neighbors = features.filter((f) => f.kind === "neighbor");
    assert.equal(neighbors.length, 1);
    assert.ok(neighbors[0].polygon.some(([x]) => x > 5));
    assert.ok(Math.abs(neighbors[0].height - 5.5) < 0.2, `2-level neighbor should be ~5.5 m, got ${neighbors[0].height}`);
    assert.equal(features.filter((f) => f.kind === "garage" && f.polygon.some(([x]) => x > 5 && x < 20)).length, 0);
  });

  it("sizes neighbor shells from OSM levels/height or the focus house eave", () => {
    assert.equal(neighborShellHeight({ levels: 3, mainEave: 5.4 }), 8.25);
    assert.ok(Math.abs(neighborShellHeight({ heightM: 10, mainEave: 5.4 }) - 8.8) < 0.05);
    assert.equal(neighborShellHeight({ mainEave: 5.4 }), 5.4);
    const wide: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const ranch: [number, number][] = [[5, -4], [25, -4], [25, 4], [5, 4]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: wide,
      structures: [
        { id: 1, tag: "house", ring: wide, area: 80 },
        { id: 2, tag: "house", ring: ranch, area: 400 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      mainEaveHeight: 2.8,
    });
    const n = features.find((f) => f.kind === "neighbor");
    assert.ok(n);
    assert.ok(n!.height <= 4, `wide ranch without levels should match 1-story eave, got ${n!.height}`);
  });

  it("scales accessory reach with foundation size and drops far campus buildings", () => {
    const cottage: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const campus: [number, number][] = [[-40, -30], [40, -30], [40, 30], [-40, 30]];
    assert.ok(accessoryReach(cottage) < accessoryReach(campus));
    const hugeLot: [number, number][] = [[-80, -80], [80, -80], [80, 80], [-80, 80]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: cottage,
      structures: [
        { id: 1, tag: "house", ring: cottage, area: 80 },
        { id: 2, tag: "yes", ring: [[6, 8], [12, 8], [12, 14], [6, 14]], area: 36 },
        { id: 3, tag: "yes", ring: [[50, 40], [62, 40], [62, 55], [50, 55]], area: 180 },
        { id: 4, tag: "garage", ring: [[55, -10], [62, -10], [62, -4], [55, -4]], area: 40 },
      ],
      fences: [],
      pools: [],
      parcel: hugeLot,
      aerial: [],
    });
    const outs = features.filter((f) => f.kind === "garage" || f.kind === "shed");
    assert.ok(outs.length >= 1, "near accessory on the lot should stay");
    assert.ok(
      !outs.some((f) => f.polygon.some(([x]) => x > 40)),
      "far campus buildings outside accessory reach must not render as garages",
    );
  });

  it("pads a convex hull around the house and garage", () => {
    const hull = siteHull(
      [
        [[-5, -4], [5, -4], [5, 4], [-5, 4]],
        [[6, 16], [11, 16], [11, 22], [6, 22]],
      ],
      3,
    );
    assert.ok(hull && hull.length >= 4);
    assert.ok(pointInRing([0, 0], hull!));
    assert.ok(pointInRing([8, 19], hull!));
  });

  it("cross-verify keeps OSM garage when aerial agrees and fills a missing driveway", () => {
    const features = crossVerifySiteFeatures({
      features: [
        {
          id: "g1",
          kind: "garage",
          label: "Garage",
          polygon: [[6, 16], [11, 16], [11, 22], [6, 22]],
          height: 2.6,
          source: "map",
        },
      ],
      aerialCues: [
        {
          kind: "garage",
          label: "Garage",
          polygon: [[6.5, 16.5], [10.5, 16.5], [10.5, 21.5], [6.5, 21.5]],
          confidence: 0.7,
        },
        {
          kind: "driveway",
          label: "Driveway",
          polygon: [[-2, -12], [2, -12], [2, -20], [-2, -20]],
          confidence: 0.55,
        },
      ],
      geminiGarage: "detached",
    });
    assert.ok(features.some((f) => f.kind === "garage" && f.source === "map"));
    assert.ok(features.some((f) => f.kind === "driveway" && f.source === "aerial"));
  });

  it("keeps a large attached wing even when its centroid is far from the focus wall", () => {
    const focus: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    // 40 m deep wing sharing the east wall — centroid sits ~20 m out.
    const wing: [number, number][] = [[5, -4], [45, -4], [45, 4], [5, 4]];
    assert.equal(ringSeparation(focus, wing), 0);
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: focus,
      structures: [
        { id: 1, tag: "house", ring: focus, area: 80 },
        { id: 2, tag: "yes", ring: wing, area: 160 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
      mainEaveHeight: 5.4,
    });
    assert.ok(features.some((f) => f.kind === "neighbor"), "touching building=yes wing should be a neighbor shell");
  });

  it("adds neighbor backyard fences/trees and keeps mapped fences on the neighbor lot", () => {
    const focus: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const nbr: [number, number][] = [[8, -4], [18, -4], [18, 4], [8, 4]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: focus,
      structures: [
        { id: 1, tag: "house", ring: focus, area: 80 },
        { id: 2, tag: "house", ring: nbr, area: 80 },
      ],
      fences: [[[20, 6], [20, 16]]],
      pools: [[[10, 10], [16, 10], [16, 14], [10, 14]]],
      parcel: [[-8, -8], [8, -8], [8, 8], [-8, 8]],
      aerial: [],
      streetDir: [0, -1],
      trees: [[12, 12]],
      mainEaveHeight: 5.4,
    });
    assert.ok(features.some((f) => f.kind === "neighbor"));
    assert.ok(features.some((f) => f.kind === "fence" && f.source === "map"), "fence beside neighbor should stay");
    assert.ok(features.some((f) => f.kind === "pool"), "neighbor backyard pool should stay");
    assert.ok(features.some((f) => f.kind === "trees" && f.source === "map"));
    assert.ok(
      features.some((f) => f.kind === "fence" && f.source === "estimated" && f.id.includes("nbr")),
      "empty neighbor rear should get estimated fence",
    );
  });

  it("infers a backyard fence and trees when the rear lot is empty", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [],
      pools: [],
      parcel: lot,
      aerial: [],
      streetDir: [0, -1],
      trees: [],
    });
    const estFences = features.filter((f) => f.kind === "fence" && f.source === "estimated");
    const estTrees = features.filter((f) => f.kind === "trees" && f.source === "estimated");
    assert.ok(estFences.length >= 2, `expected rear fence segments, got ${estFences.length}`);
    assert.ok(estTrees.length >= 2, `expected backyard trees, got ${estTrees.length}`);
    for (const t of estTrees) {
      const c = t.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
      assert.ok(c[1] > 0, "estimated trees should sit behind the house (+y)");
    }
  });

  it("keeps mapped backyard trees and skips inferred fill when fences already cover the rear", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [
        [[-8, 10], [-8, 28]],
        [[-8, 28], [12, 28]],
        [[12, 28], [12, 10]],
      ],
      pools: [],
      parcel: lot,
      aerial: [],
      streetDir: [0, -1],
      trees: [[0, 18], [4, 20]],
    });
    assert.ok(features.some((f) => f.kind === "trees" && f.source === "map"));
    assert.equal(features.filter((f) => f.kind === "trees" && f.source === "estimated").length, 0);
    assert.equal(features.filter((f) => f.kind === "fence" && f.source === "estimated").length, 0);
    assert.ok(features.filter((f) => f.kind === "fence" && f.source === "map").length >= 3);
  });
});
