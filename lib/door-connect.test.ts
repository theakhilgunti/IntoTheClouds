import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectZonesWithDoors,
  openingBetween,
  pickStartZone,
  type ConnectWall,
} from "./door-connect.ts";
import { wallsAlongOutline } from "./outline.ts";

describe("door connectivity", () => {
  it("prefers hall/lobby as the start zone", () => {
    assert.equal(pickStartZone(["kitchen", "hall", "bed"]), "hall");
    assert.equal(pickStartZone(["r1", "r2"], ["lobby-1", "r1"]), "r1");
    assert.equal(pickStartZone(["h0-hall", "h0-bed"]), "h0-hall");
  });

  it("connects rooms through shared interior walls", () => {
    const walls: ConnectWall[] = [
      { id: "w0", exterior: false, zones: ["hall", "bed"], length: 2.0 },
      { id: "w1", exterior: false, zones: ["hall", "bath"], length: 1.2 },
      { id: "w2", exterior: true, zones: ["hall", null], length: 4 },
    ];
    const { doors, reached } = connectZonesWithDoors(walls, ["hall", "bed", "bath"], {
      roomTypes: { hall: "hallway", bed: "bedroom", bath: "bathroom" },
    });
    assert.equal(doors.length, 2);
    assert.ok(reached.has("bed") && reached.has("bath"));
  });

  it("rescues sealed rooms when the shared edge is shorter than 0.7 m", () => {
    const walls: ConnectWall[] = [
      { id: "w0", exterior: false, zones: ["hall", "sealed"], length: 0.45 },
      { id: "w1", exterior: true, zones: ["hall", null], length: 5 },
    ];
    const { doors, reached } = connectZonesWithDoors(walls, ["hall", "sealed"]);
    assert.equal(doors.length, 1);
    assert.ok(reached.has("sealed"));
  });

  it("does not cut illicit bedroom–bedroom doors", () => {
    const walls: ConnectWall[] = [
      { id: "w0", exterior: false, zones: ["hall", "a"], length: 2.0 },
      { id: "w1", exterior: false, zones: ["hall", "b"], length: 2.0 },
      { id: "w2", exterior: false, zones: ["a", "b"], length: 1.5 },
      { id: "w3", exterior: true, zones: ["hall", null], length: 4 },
    ];
    const { doors, reached } = connectZonesWithDoors(walls, ["hall", "a", "b"], {
      roomTypes: { hall: "hallway", a: "bedroom", b: "bedroom" },
    });
    assert.ok(!doors.some((d) => d.wallId === "w2"), "bedrooms should not share a doorway");
    assert.equal(reached.size, 3);
    assert.ok(doors.some((d) => d.wallId === "w0"));
    assert.ok(doors.some((d) => d.wallId === "w1"));
  });

  it("opens living–kitchen as a wide open arch", () => {
    const walls: ConnectWall[] = [
      { id: "w0", exterior: false, zones: ["living", "kitchen"], length: 3.2 },
      { id: "w1", exterior: true, zones: ["living", null], length: 5 },
    ];
    const { doors } = connectZonesWithDoors(walls, ["living", "kitchen"], {
      preferredStart: ["living"],
      roomTypes: { living: "living", kitchen: "kitchen" },
    });
    const arch = doors.find((d) => d.wallId === "w0");
    assert.ok(arch, "expected living–kitchen opening");
    assert.equal(arch!.kind, "open");
    assert.ok(arch!.width >= 1.15, `open arch should be wide, got ${arch!.width}`);
  });

  it("does not illicitly open bathroom into living", () => {
    const walls: ConnectWall[] = [
      { id: "w0", exterior: false, zones: ["hall", "bath"], length: 1.2 },
      { id: "w1", exterior: false, zones: ["hall", "living"], length: 2.0 },
      { id: "w2", exterior: false, zones: ["bath", "living"], length: 1.5 },
      { id: "w3", exterior: true, zones: ["hall", null], length: 4 },
    ];
    const { doors, reached } = connectZonesWithDoors(walls, ["hall", "bath", "living"], {
      roomTypes: { hall: "hallway", bath: "bathroom", living: "living" },
    });
    assert.ok(!doors.some((d) => d.wallId === "w2"), "bathroom should not open into living");
    assert.ok(doors.some((d) => d.wallId === "w0"));
    assert.ok(reached.has("bath") && reached.has("living"));
  });

  it("classifies bedroom–bedroom as none and hall–living as open", () => {
    assert.equal(openingBetween("bedroom", "bedroom"), "none");
    assert.equal(openingBetween("bathroom", "living"), "none");
    assert.equal(openingBetween("bathroom", "hallway"), "door");
    assert.equal(openingBetween("hallway", "living"), "open");
    assert.equal(openingBetween("office", "living"), "open");
  });

  it("synthesizes an opening when rooms are separated by a clip gap", () => {
    const hall = {
      zone: "hall",
      poly: [
        [-1, -8],
        [1, -8],
        [1, 8],
        [-1, 8],
      ] as [number, number][],
    };
    // 40 cm gap — used to leave the bedroom with only exterior walls.
    const bed = {
      zone: "bed",
      poly: [
        [1.4, -3],
        [8, -3],
        [8, 2],
        [1.4, 2],
      ] as [number, number][],
    };
    const raw = wallsAlongOutline([hall, bed]);
    const walls: ConnectWall[] = raw.map((w, i) => ({
      id: `w${i}`,
      exterior: w.exterior,
      zones: w.zones,
      length: Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]),
      a: w.a,
      b: w.b,
    }));
    const { doors, reached, extraWalls } = connectZonesWithDoors(walls, ["hall", "bed"], {
      preferredStart: ["hall"],
      roomPolys: [hall, bed],
      roomTypes: { hall: "hallway", bed: "bedroom" },
    });
    assert.ok(reached.has("bed"), "bedroom must be reachable");
    assert.ok(doors.length >= 1);
    assert.ok(
      walls.some((w) => !w.exterior && w.zones.includes("bed")) || extraWalls.length > 0,
      "should share an interior wall or synthesize one",
    );
  });
});
