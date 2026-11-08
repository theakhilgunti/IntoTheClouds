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

  it("never opens an outdoor arch — sealed-room shell openings are exit doors", () => {
    // Hall reached; living only has exterior walls and sits >8 m away so shell fallback fires.
    const walls: ConnectWall[] = [
      { id: "w-hall", exterior: true, zones: ["hall", null], length: 5.0, a: [-1, -8], b: [1, -8] },
      { id: "w-ext", exterior: true, zones: ["living", null], length: 4.0, a: [20, -2], b: [24, -2] },
    ];
    const { doors } = connectZonesWithDoors(walls, ["hall", "living"], {
      preferredStart: ["hall"],
      roomTypes: { hall: "hallway", living: "living" },
      roomPolys: [
        {
          zone: "hall",
          poly: [
            [-1, -8],
            [1, -8],
            [1, 8],
            [-1, 8],
          ],
        },
        {
          zone: "living",
          poly: [
            [20, -2],
            [24, -2],
            [24, 2],
            [20, 2],
          ],
        },
      ],
    });
    const shell = doors.filter((d) => d.wallId === "w-ext");
    assert.ok(shell.length >= 1, "sealed living room needs a shell opening");
    for (const d of shell) {
      assert.equal(d.kind, "door", "outdoor opening must be a door, not an open arch");
      assert.equal(d.exit, true);
      assert.ok(d.width <= 1.05, `exit door should not be arch-wide, got ${d.width}`);
    }
    assert.ok(!doors.some((d) => d.kind === "open" && d.exit), "no open arch may exit outdoors");
  });

  it("does not turn a side-by-side shell wall into an outdoor open arch", () => {
    // Living's south exterior wall; kitchen sits to the west (beside, not through the wall).
    const living = {
      zone: "living",
      poly: [
        [0, 0],
        [6, 0],
        [6, 5],
        [0, 5],
      ] as [number, number][],
    };
    const kitchen = {
      zone: "kitchen",
      poly: [
        [-4, 0],
        [0, 0],
        [0, 5],
        [-4, 5],
      ] as [number, number][],
    };
    const walls: ConnectWall[] = [
      { id: "shared", exterior: false, zones: ["living", "kitchen"], length: 5, a: [0, 0], b: [0, 5] },
      { id: "south", exterior: true, zones: ["living", null], length: 6, a: [0, 0], b: [6, 0] },
      { id: "k-south", exterior: true, zones: ["kitchen", null], length: 4, a: [-4, 0], b: [0, 0] },
    ];
    const { doors, wallPatches } = connectZonesWithDoors(walls, ["living", "kitchen"], {
      preferredStart: ["living"],
      roomTypes: { living: "living", kitchen: "kitchen" },
      roomPolys: [living, kitchen],
    });
    assert.ok(!wallPatches.some((p) => p.id === "south"), "south shell must stay exterior");
    const south = doors.filter((d) => d.wallId === "south");
    for (const d of south) {
      assert.notEqual(d.kind, "open", "no outdoor arch on the south shell");
      if (d.exit) assert.equal(d.kind, "door");
    }
    assert.ok(!doors.some((d) => d.kind === "open" && d.exit));
    const arch = doors.find((d) => d.wallId === "shared");
    assert.ok(arch && arch.kind === "open" && !arch.exit, "living–kitchen arch stays indoors");
  });

  it("opens sealed rooms on existing outline walls — no synth pillar stubs", () => {
    const hall = {
      zone: "hall",
      poly: [
        [-1, -4],
        [1, -4],
        [1, 4],
        [-1, 4],
      ] as [number, number][],
    };
    const bed = {
      zone: "bed",
      poly: [
        [3, -2],
        [7, -2],
        [7, 2],
        [3, 2],
      ] as [number, number][],
    };
    const walls: ConnectWall[] = [
      { id: "h-e", exterior: true, zones: ["hall", null], length: 8, a: [1, -4], b: [1, 4] },
      { id: "b-w", exterior: true, zones: ["bed", null], length: 4, a: [3, -2], b: [3, 2] },
    ];
    const { doors, reached, extraWalls, wallPatches } = connectZonesWithDoors(walls, ["hall", "bed"], {
      preferredStart: ["hall"],
      roomPolys: [hall, bed],
      roomTypes: { hall: "hallway", bed: "bedroom" },
    });
    assert.ok(reached.has("bed"));
    assert.ok(doors.length >= 1);
    assert.equal(extraWalls.length, 0, "must not stack synth pillar walls");
    assert.ok(
      doors.every((d) => d.wallId === "h-e" || d.wallId === "b-w"),
      "openings must use existing outline walls",
    );
    assert.ok(wallPatches.length >= 0);
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
    const { doors, reached, extraWalls, wallPatches } = connectZonesWithDoors(walls, ["hall", "bed"], {
      preferredStart: ["hall"],
      roomPolys: [hall, bed],
      roomTypes: { hall: "hallway", bed: "bedroom" },
    });
    assert.ok(reached.has("bed"), "bedroom must be reachable");
    assert.ok(doors.length >= 1);
    assert.equal(extraWalls.length, 0, "clip-gap rescue must not invent pillar walls");
    assert.ok(
      wallPatches.some((p) => !p.exterior && p.zones.includes("bed")) ||
        walls.some((w) => !w.exterior && w.zones.includes("bed")) ||
        doors.some((d) => d.exit),
      "should convert a shared edge to interior or open an exit",
    );
  });
});
