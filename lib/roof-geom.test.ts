import assert from "node:assert/strict";
import test from "node:test";
import { buildRoofPositions, insetRing, meshOffsetRoof, splitByRidge } from "./roof-geom.ts";

const rect: [number, number][] = [
  [-4, -6], [4, -6], [4, 6], [-4, 6],
];

const ell: [number, number][] = [
  [0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12],
];

test("splitByRidge yields two halves that meet on the ridge", () => {
  const { left, right } = splitByRidge(rect, [0, -6], [0, 6]);
  assert.ok(left.length >= 3 && right.length >= 3);
  assert.ok(left.some((p) => Math.abs(p[0]) < 0.05));
  assert.ok(right.some((p) => Math.abs(p[0]) < 0.05));
});

test("insetRing shrinks a rectangle and stays oriented", () => {
  const next = insetRing(rect, 1);
  assert.ok(next && next.length >= 3);
  const area = (p: [number, number][]) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i][0] * q[1] - q[0] * p[i][1];
    }
    return Math.abs(a / 2);
  };
  assert.ok(area(next!) < area(rect) * 0.85);
});

test("a gable wing peaks along a ridge line with many high verts", () => {
  const pos = buildRoofPositions(rect, {
    shape: "gable",
    ridgeAlong: "depth",
    height: 2.4,
    wings: [{ polygon: rect, ridge: [[0, -5.5], [0, 5.5]], height: 2.4, shape: "gable" }],
  });
  const highs: [number, number][] = [];
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] > 2.0) highs.push([pos[i], -pos[i + 2]]);
  }
  assert.ok(highs.length >= 4);
  const xs = highs.map((p) => p[0]);
  const ys = highs.map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 3);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 1.2);
});

test("a hip wing uses offset loft and rises above the eaves", () => {
  const pos = buildRoofPositions(rect, {
    shape: "hip",
    ridgeAlong: "depth",
    height: 2,
    wings: [{ polygon: rect, ridge: [[-1, 0], [1, 0]], height: 2, shape: "hip" }],
  });
  let maxY = 0;
  let midY = 0;
  let midN = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    maxY = Math.max(maxY, y);
    if (y > 0.3 && y < 1.7) {
      midY += y;
      midN++;
    }
  }
  assert.ok(maxY > 1.5);
  assert.ok(midN > 8, "offset loft should create intermediate roof heights");
});

test("complex L footprints get a distance-field roof without a single apex", () => {
  const out: number[] = [];
  meshOffsetRoof(ell, 2.2, out);
  assert.ok(out.length >= 27);
  let maxY = 0;
  let midN = 0;
  for (let i = 0; i < out.length; i += 3) {
    const y = out[i + 1];
    maxY = Math.max(maxY, y);
    if (y > 0.4 && y < 1.9) midN++;
  }
  assert.ok(maxY > 1.2, `expected a raised ridge, got ${maxY}`);
  assert.ok(midN > 6, "distance field should create intermediate roof heights");
});
