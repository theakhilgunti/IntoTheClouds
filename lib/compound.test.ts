import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessFeatures,
  assembleCompound,
  boxToPolygon,
  compoundReach,
  pointInRing,
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
});
