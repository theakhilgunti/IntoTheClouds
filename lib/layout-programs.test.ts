import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildingUseFromTag,
  buildingUseFromTags,
  maxStoriesForUse,
  planWordForUse,
} from "./layout-use.ts";
import { planCorridorUnits, type CorridorUnitKind } from "./layout-corridor.ts";

describe("building programs", () => {
  it("maps OSM tags to dormitory / apartments / hotel / hospital / warehouse", () => {
    assert.equal(buildingUseFromTag("dormitory"), "dormitory");
    assert.equal(buildingUseFromTag("apartments"), "apartments");
    assert.equal(buildingUseFromTag("hotel"), "hotel");
    assert.equal(buildingUseFromTag("hospital"), "hospital");
    assert.equal(buildingUseFromTag("warehouse"), "warehouse");
    assert.equal(buildingUseFromTag("industrial"), "warehouse");
    assert.equal(buildingUseFromTag("house"), "house");
    assert.equal(buildingUseFromTags({ building: "yes", amenity: "hospital" }), "hospital");
    assert.equal(buildingUseFromTags({ building: "residential", amenity: "hotel" }), "hotel");
  });

  it("raises story caps for multi-unit and institutional uses", () => {
    assert.equal(maxStoriesForUse("house"), 3);
    assert.equal(maxStoriesForUse("church"), 1);
    assert.equal(maxStoriesForUse("dormitory"), 6);
    assert.equal(maxStoriesForUse("apartments"), 6);
    assert.equal(maxStoriesForUse("hotel"), 6);
    assert.equal(maxStoriesForUse("hospital"), 6);
    assert.equal(maxStoriesForUse("warehouse"), 3);
    assert.equal(planWordForUse("dormitory"), "dormitory");
  });
});

function namesOn(level: number, kind: CorridorUnitKind) {
  const notes: string[] = [];
  const floors = planCorridorUnits({ width: 44, depth: 28, stories: 3 }, notes, kind);
  return floors.find((f) => f.level === level)!.rooms.map((r) => r.name);
}

describe("per-level program floors", () => {
  it("hotel: lobby/restaurant on L0, guest rooms on upper floors", () => {
    const g = namesOn(0, "hotel");
    const u = namesOn(1, "hotel");
    assert.ok(g.some((n) => /Lobby/i.test(n)));
    assert.ok(g.some((n) => /Restaurant|Meeting/i.test(n)));
    assert.ok(!g.some((n) => /^Guest /i.test(n)), "ground should not be guest-room corridor");
    assert.ok(u.some((n) => /^Guest /i.test(n)));
    assert.ok(!u.some((n) => /Lobby|Restaurant/i.test(n)));
  });

  it("hospital: ED/clinic on L0, patient wards above", () => {
    const g = namesOn(0, "hospital");
    const u = namesOn(2, "hospital");
    assert.ok(g.some((n) => /Admitting|Emergency|Clinic/i.test(n)));
    assert.ok(!g.some((n) => /^Patient /i.test(n)));
    assert.ok(u.some((n) => /^Patient /i.test(n)));
    assert.ok(u.some((n) => /Nurse/i.test(n)));
  });

  it("dormitory: lounge/laundry on L0, bedrooms above", () => {
    const g = namesOn(0, "dormitory");
    const u = namesOn(1, "dormitory");
    assert.ok(g.some((n) => /Lounge|Laundry|Study/i.test(n)));
    assert.ok(!g.some((n) => /^Room /i.test(n)));
    assert.ok(u.some((n) => /^Room /i.test(n)));
  });

  it("apartments: lobby on L0, denser units above", () => {
    const g = namesOn(0, "apartments");
    const u = namesOn(1, "apartments");
    assert.ok(g.some((n) => /Lobby|Mail/i.test(n)));
    const gUnits = g.filter((n) => /Unit G/i.test(n)).length;
    const uUnits = u.filter((n) => /Unit 2/i.test(n)).length;
    assert.ok(uUnits > gUnits, "upper floors should have more unit pads than ground");
  });
});
