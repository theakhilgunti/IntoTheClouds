import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BuildingModel } from "@/packages/schema/building-model";
import { findNeighborFeature, reframeModelToNeighbor, reframeScanToNeighbor } from "./reframe-neighbor.ts";
import type { ScanResult } from "./sources.ts";

function baseModel(): BuildingModel {
  const footprint: [number, number][] = [
    [-5, -4],
    [5, -4],
    [5, 4],
    [-5, 4],
  ];
  const nbr: [number, number][] = [
    [12, -4],
    [22, -4],
    [22, 4],
    [12, 4],
  ];
  return {
    id: "osm-100",
    source: "address",
    confidence: 0.8,
    address: "10 Main St",
    lat: 42.73,
    lng: -73.68,
    footprint,
    floors: [
      {
        level: 0,
        name: "Ground",
        elevation: 0,
        height: 2.8,
        rooms: [],
        walls: [],
        doors: [],
        stairs: [],
      },
      {
        level: 1,
        name: "Upper",
        elevation: 2.8,
        height: 2.8,
        rooms: [],
        walls: [],
        doors: [],
        stairs: [],
      },
    ],
    markers: [],
    compound: {
      basis: "compound-v44",
      grade: {
        downhill: [0, -1],
        slope: 0.035,
        origin: [0, 0],
        dem: {
          x0: -40,
          y0: -40,
          cell: 20,
          cols: 5,
          rows: 5,
          z: Array.from({ length: 25 }, (_, i) => (i % 5) * 0.2),
          source: "test",
        },
      },
      features: [
        {
          id: "road-0",
          kind: "road",
          label: "Main",
          polygon: [
            [-30, -14],
            [40, -14],
            [40, -10],
            [-30, -10],
          ],
          height: 0.08,
          source: "map",
        },
        {
          id: "neighbor-200",
          kind: "neighbor",
          label: "18 Main St",
          polygon: nbr,
          height: 5.5,
          source: "map",
        },
        {
          id: "neighbor-300",
          kind: "neighbor",
          label: "22 Main St",
          polygon: [
            [30, -4],
            [40, -4],
            [40, 4],
            [30, 4],
          ],
          height: 5.5,
          source: "map",
        },
      ],
    },
  };
}

describe("reframe neighbor", () => {
  it("finds neighbor shells by OSM way id", () => {
    const m = baseModel();
    assert.equal(findNeighborFeature(m, 200)?.label, "18 Main St");
    assert.equal(findNeighborFeature(m, 999), null);
  });

  it("moves the chosen neighbor to the origin and keeps roads", () => {
    const next = reframeModelToNeighbor(baseModel(), 200);
    assert.equal(next.id, "osm-200");
    assert.equal(next.address, "18 Main St");
    const c = next.footprint.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    assert.ok(Math.hypot(c[0], c[1]) < 0.5, `new footprint should be near origin, got ${c}`);
    assert.ok(next.compound?.features.some((f) => f.kind === "road"), "road reused");
    assert.ok(
      next.compound?.features.some((f) => f.id === "neighbor-100"),
      "old focus becomes a neighbor shell",
    );
    assert.ok(!next.compound?.features.some((f) => f.id === "neighbor-200"), "chosen shell removed");
    assert.ok(next.floors.length >= 1, "local interior built");
    assert.equal(next.interior?.status, "estimated");
    // DEM origin shifted with the frame.
    assert.ok(next.compound?.grade?.dem);
    assert.ok(Math.abs((next.compound!.grade!.dem!.x0) - (-40 - 17)) < 0.01 || next.compound!.grade!.dem!.x0 < -40);
  });

  it("updates scan summary after reframe", () => {
    const model = baseModel();
    const result: ScanResult = {
      model,
      sources: [],
      attributes: [],
      warnings: [],
      images: [],
      summary: {
        width: 10,
        depth: 8,
        area: 80,
        facing: "south",
        stories: 2,
        nearby: [
          { id: 100, label: "10 Main St" },
          { id: 200, label: "18 Main St" },
        ],
        match: "address",
      },
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    const next = reframeScanToNeighbor(result, 200);
    assert.equal(next.model.id, "osm-200");
    assert.equal(next.summary.match, "nearest");
    assert.ok(next.warnings.some((w) => /reused/i.test(w)));
  });
});
