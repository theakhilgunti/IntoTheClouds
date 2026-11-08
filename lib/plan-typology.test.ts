import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintLayout, softCheckTypology, typologyDistance } from "./plan-typology.ts";
import { overlayIndoorOnModel } from "./indoor-overlay.ts";

describe("plan typology", () => {
  it("accepts a plausible house fingerprint", () => {
    const check = softCheckTypology({
      program: "house",
      bedrooms: 3,
      baths: 2,
      corridorFrac: 0.1,
      aspect: 1.1,
    });
    assert.equal(check.ok, true);
    assert.ok(check.distance <= 1.25);
  });

  it("flags extreme dorm mixes and suggests median bays", () => {
    const check = softCheckTypology({
      program: "dormitory",
      bedrooms: 0,
      baths: 0,
      corridorFrac: 0.9,
      aspect: 10,
    });
    assert.equal(check.ok, false);
    assert.ok(check.nudgeBays != null && check.nudgeBays >= 2);
    assert.match(check.note, /Typology check/);
  });

  it("fingerprints bedroom counts from floors", () => {
    const fp = fingerprintLayout(
      [
        {
          level: 0,
          rooms: [
            { type: "bedroom", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
            { type: "bathroom", polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] },
            { type: "hallway", polygon: [[0, 0], [1, 0], [1, 8], [0, 8]] },
          ],
        },
      ],
      "house",
      10,
      8,
    );
    assert.equal(fp.bedrooms, 1);
    assert.equal(fp.baths, 1);
    assert.ok(fp.corridorFrac > 0);
  });

  it("typologyDistance is zero inside bands", () => {
    const d = typologyDistance(
      { program: "house", bedrooms: 3, baths: 2, corridorFrac: 0.1, aspect: 1 },
      {
        program: "house",
        bedrooms: [2, 4],
        baths: [1, 3],
        corridorFrac: [0.04, 0.16],
        aspect: [0.65, 1.55],
        medianBays: 3,
      },
    );
    assert.equal(d, 0);
  });
});

describe("indoor overlay", () => {
  it("returns null when too few rooms hit the footprint", () => {
    const model = {
      footprint: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      floors: [
        {
          level: 0,
          rooms: [{ id: "r", name: "Room", type: "other", polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }],
        },
      ],
    };
    const rooms = [
      {
        id: 1,
        name: "Far",
        type: "other",
        level: 0,
        ring: [
          [50, 50],
          [55, 50],
          [55, 55],
          [50, 55],
        ],
      },
    ];
    assert.equal(overlayIndoorOnModel(model, rooms), null);
  });

  it("overlays indoor rooms that sit inside the footprint", () => {
    const model = {
      footprint: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      floors: [
        {
          level: 0,
          rooms: [
            { id: "old", name: "Old", type: "other", polygon: [[-8, -8], [8, -8], [8, 8], [-8, 8]] },
            { id: "st", name: "Stairs", type: "stair", polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
          ],
        },
      ],
    };
    const mk = (id: number, x: number, y: number) => ({
      id,
      name: `R${id}`,
      type: "bedroom",
      level: 0,
      ring: [
        [x, y],
        [x + 3, y],
        [x + 3, y + 3],
        [x, y + 3],
      ] as [number, number][],
    });
    const overlay = overlayIndoorOnModel(model, [mk(1, -6, -6), mk(2, 0, -6), mk(3, 3, 3)]);
    assert.ok(overlay);
    assert.equal(overlay!.used, 3);
    assert.ok(overlay!.model.floors[0].rooms.some((r) => r.name === "R1"));
    assert.ok(overlay!.model.floors[0].rooms.some((r) => r.type === "stair"));
    assert.match(overlay!.model.interior?.source ?? "", /Indoor/);
  });
});
