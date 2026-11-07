import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyExploration, boundsOf, measureModel, type ExplorationInput, type HouseRecord } from "./explored-house.ts";

function walk(points: Array<{ x: number; y: number; z: number }>, hazards: ExplorationInput["hazards"] = []): ExplorationInput {
  return {
    buildingId: "explored",
    deviceId: "rig",
    startedAt: "2026-11-07T00:00:00.000Z",
    endedAt: "2026-11-07T00:01:00.000Z",
    lat: 42.73,
    lng: -73.68,
    address: "Walk",
    breadcrumbs: points,
    hazards,
  };
}

describe("explored house", () => {
  it("centers the walked extent and keeps measured size", () => {
    const result = applyExploration(
      null,
      walk(
        [
          { x: 0, y: 0, z: 1 },
          { x: 10, y: 0, z: 1 },
          { x: 10, y: 4, z: 1 },
        ],
        [{ id: "h1", hazard_type: "collapse", x: 10, y: 4, z: 1, note: "wall", timestamp: 1_700_000_000 }],
      ),
    );

    assert.equal(result.placedOnPlan, true);
    assert.deepEqual(result.model.footprint[0], [-5, -2]);
    assert.equal(result.model.markers[0].type, "hazard");
    assert.deepEqual(result.model.markers[0].pos, [5, 2]);

    const dimensions = measureModel(result.model, {
      exploredWidthM: result.exploredWidthM,
      exploredDepthM: result.exploredDepthM,
    });
    assert.equal(dimensions.widthM, 10);
    assert.equal(dimensions.depthM, 4);
    assert.equal(dimensions.footprintAreaM2, 40);
    assert.equal(dimensions.floors[0].rooms[0].areaM2, 40);
    assert.equal(dimensions.exploredWidthM, 10);
    assert.equal(dimensions.exploredDepthM, 4);
  });

  it("rebuilds a wifi house from the whole trail", () => {
    const first = applyExploration(
      null,
      walk([
        { x: 0, y: 0, z: 1 },
        { x: 4, y: 0, z: 1 },
      ]),
    );
    const existing: HouseRecord = {
      ...first.model,
      rawTrail: first.rawTrail,
      rawHazards: first.rawHazards,
      revision: first.revision,
    };
    const second = applyExploration(
      existing,
      walk([
        { x: 4, y: 0, z: 1 },
        { x: 4, y: 6, z: 1 },
      ]),
    );

    assert.equal(second.model.source, "wifi");
    assert.equal(boundsOf(second.rawTrail).measuredWidth, 4);
    assert.equal(boundsOf(second.rawTrail).measuredDepth, 6);
    assert.equal(second.revision, 2);
  });

  it("saves a scanner walk as a wifi house instead of a surveyed plan", () => {
    const surveyed = applyExploration(
      {
        id: "demo",
        source: "demo",
        confidence: 0.5,
        address: "Demo house",
        lat: 1,
        lng: 2,
        footprint: [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ],
        floors: [],
        markers: [],
        revision: 3,
      },
      walk([
        { x: 0, y: 0, z: 1 },
        { x: 2, y: 2, z: 1 },
      ]),
    );

    assert.equal(surveyed.placedOnPlan, true);
    assert.equal(surveyed.model.source, "wifi");
    assert.equal(surveyed.model.id, "explored");
    assert.equal(surveyed.revision, 1);
    assert.equal(surveyed.exploredWidthM, 2);
    assert.equal(surveyed.exploredDepthM, 2);
  });
});
