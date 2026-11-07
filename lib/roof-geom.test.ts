import assert from "node:assert/strict";
import test from "node:test";
import { buildRoofPositions, insetRing, meshHipPiece, splitByRidge } from "./roof-geom.ts";

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

test("insetRing keeps the same vertex count as the eaves", () => {
  const next = insetRing(rect, 1);
  assert.ok(next);
  assert.equal(next!.length, rect.length);
});

test("gable piece peaks along a ridge from wall vertices", () => {
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
  assert.ok(highs.length >= 2);
  const xs = highs.map((p) => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 1.5);
});

test("hip piece builds matching edge quads and a sealed deck", () => {
  const out: number[] = [];
  meshHipPiece(rect, 2, out);
  assert.ok(out.length >= 9 * 3);
  let maxY = 0;
  let deck = 0;
  for (let i = 1; i < out.length; i += 3) {
    maxY = Math.max(maxY, out[i]);
    if (out[i] <= 0.06) deck++;
  }
  assert.ok(maxY > 1.5);
  assert.ok(deck >= 3);
});

test("L footprint uses hip edge faces and stays raised", () => {
  const out: number[] = [];
  meshHipPiece(ell, 2.2, out);
  let maxY = 0;
  for (let i = 1; i < out.length; i += 3) maxY = Math.max(maxY, out[i]);
  assert.ok(maxY > 1.0);
  assert.ok(out.length > 40);
});
