import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildingUseFromTag,
  buildingUseFromTags,
  floorStackMetric,
  gradeInsetsFirstFloor,
  maxStoriesForUse,
  planWordForUse,
} from "./layout-use.ts";
import { planCorridorUnits, type CorridorUnitKind } from "./layout-corridor.ts";
import { planLibrary, planUniversity } from "./layout-campus.ts";

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

  it("splits university / college from K–12 school and maps library", () => {
    assert.equal(buildingUseFromTag("university"), "university");
    assert.equal(buildingUseFromTag("college"), "university");
    assert.equal(buildingUseFromTag("college_building"), "university");
    assert.equal(buildingUseFromTag("school"), "school");
    assert.equal(buildingUseFromTag("kindergarten"), "school");
    assert.equal(buildingUseFromTag("library"), "library");
    assert.equal(buildingUseFromTags({ building: "yes", amenity: "university" }), "university");
    assert.equal(buildingUseFromTags({ building: "public", amenity: "library" }), "library");
    assert.equal(buildingUseFromTags({ building: "yes", amenity: "college" }), "university");
    assert.equal(buildingUseFromTags({ building: "yes", amenity: "school" }), "school");
  });

  it("raises story caps for multi-unit and institutional uses", () => {
    assert.equal(maxStoriesForUse("house"), 5);
    assert.equal(maxStoriesForUse("church"), 2);
    assert.equal(maxStoriesForUse("dormitory"), 12);
    assert.equal(maxStoriesForUse("apartments"), 12);
    assert.equal(maxStoriesForUse("hotel"), 12);
    assert.equal(maxStoriesForUse("hospital"), 12);
    assert.equal(maxStoriesForUse("university"), 12);
    assert.equal(maxStoriesForUse("library"), 12);
    assert.equal(maxStoriesForUse("warehouse"), 5);
    assert.equal(planWordForUse("dormitory"), "dormitory");
    assert.equal(planWordForUse("university"), "university");
    assert.equal(planWordForUse("library"), "library");
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

  it("tall dormitory: lowest floor digs into grade; four floors sit above", () => {
    assert.equal(gradeInsetsFirstFloor("dormitory", 5), true);
    assert.equal(gradeInsetsFirstFloor("dormitory", 3), false);
    assert.equal(gradeInsetsFirstFloor("house", 5), false);
    const base = floorStackMetric(0, { insetGrade: true });
    const first = floorStackMetric(1, { insetGrade: true });
    const top = floorStackMetric(4, { insetGrade: true });
    assert.equal(base.name, "Basement");
    assert.ok(base.elevation < -1.5);
    assert.equal(first.name, "1st Floor");
    assert.equal(first.elevation, 0);
    assert.equal(top.name, "4th Floor");
  });

  it("apartments: lobby on L0, denser units above", () => {
    const g = namesOn(0, "apartments");
    const u = namesOn(1, "apartments");
    assert.ok(g.some((n) => /Lobby|Mail/i.test(n)));
    const gUnits = g.filter((n) => /Unit G/i.test(n)).length;
    const uUnits = u.filter((n) => /Unit 2/i.test(n)).length;
    assert.ok(uUnits > gUnits, "upper floors should have more unit pads than ground");
  });

  it("university: atrium/lecture on L0, labs/faculty above — not K–12 classrooms", () => {
    const notes: string[] = [];
    const floors = planUniversity({ width: 48, depth: 36, stories: 3 }, notes);
    const g = floors.find((f) => f.level === 0)!.rooms.map((r) => r.name);
    const u = floors.find((f) => f.level === 1)!.rooms.map((r) => r.name);
    assert.ok(g.some((n) => /Atrium|Lobby/i.test(n)));
    assert.ok(g.some((n) => /Lecture/i.test(n)));
    assert.ok(!g.some((n) => /Nurse|Cafeteria|Classroom/i.test(n)), "should not reuse K–12 school rooms");
    assert.ok(u.some((n) => /Lab|Seminar|Faculty/i.test(n)));
    assert.ok(!u.some((n) => /Atrium|Lecture Hall/i.test(n)));
    assert.ok(notes.some((n) => /University/i.test(n)));
  });

  it("library: lobby/desk/stacks on L0, study floors above", () => {
    const notes: string[] = [];
    const floors = planLibrary({ width: 40, depth: 30, stories: 2 }, notes);
    const g = floors.find((f) => f.level === 0)!.rooms.map((r) => r.name);
    const u = floors.find((f) => f.level === 1)!.rooms.map((r) => r.name);
    assert.ok(g.some((n) => /Lobby/i.test(n)));
    assert.ok(g.some((n) => /Circulation|Stacks/i.test(n)));
    assert.ok(u.some((n) => /Stacks|Study|Quiet/i.test(n)));
    assert.ok(notes.some((n) => /Library/i.test(n)));
  });
});
