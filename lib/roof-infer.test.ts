import assert from "node:assert/strict";
import test from "node:test";
import { classifyFootprint, inferRoofPlan, splitLWings } from "./roof-infer.ts";
import { buildRoofPositions } from "./roof-geom.ts";

const rect: [number, number][] = [
  [-4, -8], [4, -8], [4, 8], [-4, 8],
];

const square: [number, number][] = [
  [-5, -5], [5, -5], [5, 5], [-5, 5],
];

const ell: [number, number][] = [
  [0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12],
];

const step: [number, number][] = [
  [-8, -2], [1.2, -3], [1.1, -4.2], [7, -4.8], [7.6, 2.5], [-7.5, 4.2],
];

test("elongated footprints become a single gable with a ridge segment", () => {
  assert.equal(classifyFootprint(rect).kind, "elongated");
  const plan = inferRoofPlan({ footprint: rect });
  assert.equal(plan.kind, "gable");
  assert.equal(plan.wings.length, 1);
  assert.ok(plan.wings[0].ridge);
  const [a, b] = plan.wings[0].ridge!;
  assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1]) > 4);
});

test("square footprints become a hip with a short ridge", () => {
  assert.equal(classifyFootprint(square).kind, "square");
  const plan = inferRoofPlan({ footprint: square });
  assert.equal(plan.kind, "hip");
  assert.equal(plan.wings[0].shape, "hip");
  assert.ok(plan.wings[0].ridge);
});

test("L footprints split into two gable wings", () => {
  assert.equal(classifyFootprint(ell).kind, "L");
  const parts = splitLWings(ell);
  assert.ok(parts.length >= 2);
  const plan = inferRoofPlan({ footprint: ell });
  assert.equal(plan.kind, "wings");
  assert.ok(plan.wings.length >= 2);
  for (const w of plan.wings) assert.ok(w.ridge);
});

test("OSM flat overrides footprint", () => {
  const plan = inferRoofPlan({ footprint: rect, osmTags: { "roof:shape": "flat" } });
  assert.equal(plan.kind, "flat");
  assert.equal(plan.source, "map");
});

test("gable mesh peaks along a ridge line, not a single apex", () => {
  const plan = inferRoofPlan({ footprint: rect });
  const pos = buildRoofPositions(rect, {
    shape: "gable",
    ridgeAlong: "depth",
    height: 2.4,
    wings: plan.wings,
  });
  assert.ok(pos.length >= 9);
  const highs: [number, number][] = [];
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] > 2.0) highs.push([pos[i], -pos[i + 2]]);
  }
  assert.ok(highs.length >= 4, "need several high verts on the ridge");
  // High points should be nearly collinear (spread along one axis).
  const xs = highs.map((p) => p[0]);
  const ys = highs.map((p) => p[1]);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const ySpan = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.max(xSpan, ySpan) > 3);
  assert.ok(Math.min(xSpan, ySpan) < 1.2);
});

test("a stepped house stays one elongated gable, not a false L", () => {
  assert.equal(classifyFootprint(step).kind, "elongated");
  const plan = inferRoofPlan({ footprint: step });
  assert.equal(plan.kind, "gable");
  assert.equal(plan.wings.length, 1);
  assert.ok(plan.wings[0].ridge);
  const pos = buildRoofPositions(step, {
    shape: "gable",
    ridgeAlong: plan.ridgeAlong,
    height: 2.4,
    wings: plan.wings,
  });
  let maxY = 0;
  for (let i = 1; i < pos.length; i += 3) maxY = Math.max(maxY, pos[i]);
  assert.ok(maxY > 1.5);
});
