import { describe, expect, it } from "vitest";
import type { BuildingModel, Floor, Room } from "../packages/schema/building-model";
import { confidenceRisk, riskColor, scoreRooms } from "./structural-risk";

const FOOTPRINT: [number, number][] = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];

function room(partial: Partial<Room> & Pick<Room, "id" | "type">): Room {
  return {
    name: partial.name ?? partial.id,
    polygon: partial.polygon ?? [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ],
    ...partial,
  };
}

function floor(partial: Partial<Floor> & Pick<Floor, "level" | "rooms">): Floor {
  return {
    name: partial.name ?? `L${partial.level}`,
    elevation: partial.elevation ?? partial.level * 2.7,
    height: partial.height ?? 2.7,
    walls: [],
    doors: [],
    stairs: [],
    ...partial,
  };
}

function model(partial: Partial<BuildingModel> & Pick<BuildingModel, "floors" | "interior">): BuildingModel {
  return {
    id: "test",
    source: "demo",
    confidence: 0.5,
    address: "",
    lat: 0,
    lng: 0,
    footprint: FOOTPRINT,
    markers: [],
    ...partial,
  };
}

describe("scoreRooms", () => {
  it("verified interior rooms score lower than estimated", () => {
    const rooms = [room({ id: "living", type: "living", name: "Living" })];
    const verified = scoreRooms(
      model({
        interior: { status: "verified", reasons: [], knownLevels: [0], notes: [] },
        floors: [floor({ level: 0, rooms })],
      }),
    );
    const estimated = scoreRooms(
      model({
        interior: { status: "estimated", reasons: [], knownLevels: [], notes: [] },
        floors: [floor({ level: 0, rooms })],
      }),
    );
    expect(verified).toHaveLength(1);
    expect(estimated).toHaveLength(1);
    expect(verified[0].score).toBeLessThan(estimated[0].score);
  });

  it("basement gets higher score than same room upstairs when applicable", () => {
    const poly: [number, number][] = [
      [-1.5, -1.5],
      [1.5, -1.5],
      [1.5, 1.5],
      [-1.5, 1.5],
    ];
    const scored = scoreRooms(
      model({
        interior: { status: "estimated", reasons: [], knownLevels: [], notes: [] },
        floors: [
          floor({
            level: -1,
            elevation: -2.7,
            rooms: [room({ id: "util-b", type: "utility", name: "Utility", polygon: poly })],
          }),
          floor({
            level: 0,
            elevation: 0,
            rooms: [
              room({ id: "util-g", type: "utility", name: "Utility", polygon: poly }),
              room({ id: "living", type: "living", name: "Living" }),
            ],
          }),
        ],
      }),
    );
    const bas = scored.find((r) => r.roomId === "util-b")!;
    const up = scored.find((r) => r.roomId === "util-g")!;
    expect(bas.score).toBeGreaterThan(up.score);
    expect(bas.reasons.some((s) => /basement/i.test(s))).toBe(true);
  });

  it("empty unknown with no rooms → []", () => {
    const scored = scoreRooms(
      model({
        interior: { status: "unknown", reasons: ["no plan"], knownLevels: [], notes: [] },
        floors: [floor({ level: 0, rooms: [] })],
      }),
    );
    expect(scored).toEqual([]);
  });

  it("confidenceRisk is an alias of scoreRooms", () => {
    expect(confidenceRisk).toBe(scoreRooms);
  });
});

describe("riskColor", () => {
  it("moves amber toward red as score rises", () => {
    const low = riskColor(0);
    const high = riskColor(1);
    expect(low.toLowerCase()).toBe("#f59e0b");
    expect(high.toLowerCase()).toBe("#dc2626");
    expect(low).not.toBe(high);
  });
});
