import { describe, expect, it } from "vitest";
import type { BuildingModel, Floor, Point } from "../packages/schema/building-model.ts";
import { buildVentGraph, smokeLikelyStacks } from "./vent-paths.ts";

const stairPoly: Point[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function floorWithStair(level: number, elev: number, poly: Point[] = stairPoly): Floor {
  return {
    level,
    name: `L${level}`,
    elevation: elev,
    height: 2.7,
    rooms: [{ id: `stair-${level}`, name: "Stairs", type: "stair", polygon: poly }],
    walls: [],
    doors: [],
    stairs: [{ id: `s-${level}`, polygon: poly, toLevel: level + 1 }],
  };
}

function bareModel(floors: Floor[]): BuildingModel {
  return {
    id: "vent-test",
    source: "demo",
    confidence: 1,
    address: "",
    lat: 0,
    lng: 0,
    footprint: [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ],
    floors,
    markers: [],
  };
}

describe("buildVentGraph", () => {
  it("links aligned stair rooms across 3 floors into one stack [0,1,2]", () => {
    const model = bareModel([
      floorWithStair(0, 0),
      floorWithStair(1, 2.7),
      floorWithStair(2, 5.4),
    ]);
    const graph = buildVentGraph(model);
    expect(graph.stacks).toHaveLength(1);
    expect(graph.stacks[0].levels).toEqual([0, 1, 2]);
    expect(graph.stacks[0].kind).toBe("stair");
    expect(graph.stacks[0].centers).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.kind === "stair").length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty stacks when there are no stairs", () => {
    const emptyFloor = (level: number, elev: number): Floor => ({
      level,
      name: `L${level}`,
      elevation: elev,
      height: 2.7,
      rooms: [{ id: `hall-${level}`, name: "Hall", type: "hallway", polygon: stairPoly }],
      walls: [],
      doors: [],
      stairs: [],
    });
    const graph = buildVentGraph(bareModel([emptyFloor(0, 0), emptyFloor(1, 2.7)]));
    expect(graph.stacks).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});

describe("smokeLikelyStacks", () => {
  it("includes the stair stack when fire is on floor 0", () => {
    const model = bareModel([
      floorWithStair(0, 0),
      floorWithStair(1, 2.7),
      floorWithStair(2, 5.4),
    ]);
    const graph = buildVentGraph(model);
    const likely = smokeLikelyStacks(graph, 0);
    expect(likely.length).toBe(1);
    expect(likely[0].levels).toEqual([0, 1, 2]);
    expect(likely[0].id).toBe(graph.stacks[0].id);
  });
});
