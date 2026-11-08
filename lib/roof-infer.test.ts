import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFootprint,
  decomposeRoofVolumes,
  inferRoofPlan,
  joinIntersectingLWings,
  joinMainAndWings,
  splitLWings,
} from "./roof-infer.ts";
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

test("L roofs: taller main trunk, lower wing, sealed prism mesh", () => {
  const parts = splitLWings(ell);
  assert.ok(parts.length >= 2);
  const wings = joinIntersectingLWings(parts);
  assert.ok(wings[0].height >= wings[1].height);
  assert.ok(wings[0].ridge && wings[1].ridge);
  // Each wing keeps a full ridge (no mid-air clip) — length should be meaningful.
  for (const w of wings) {
    const [a, b] = w.ridge!;
    assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1]) > 1.5);
  }
  const pos = buildRoofPositions(ell, {
    shape: "gable",
    ridgeAlong: "depth",
    height: wings[0].height,
    wings,
  });
  assert.ok(pos.length > 40);
  // No NaNs / degenerate verts.
  assert.ok(pos.every((n) => Number.isFinite(n)));
});

test("OSM flat overrides footprint", () => {
  const plan = inferRoofPlan({ footprint: rect, osmTags: { "roof:shape": "flat" } });
  assert.equal(plan.kind, "flat");
  assert.equal(plan.source, "map");
});

test("flat L roofs split into volumes and do not fill the courtyard", () => {
  const plan = inferRoofPlan({ footprint: ell, osmTags: { "roof:shape": "flat" } });
  assert.ok(plan.wings.length >= 2, "flat L should be multi-wing");
  assert.ok(plan.wings.every((w) => w.shape === "flat"));
  const pos = buildRoofPositions(ell, {
    shape: "flat",
    ridgeAlong: "depth",
    height: 0.5,
    wings: plan.wings,
  });
  assert.ok(pos.length > 20);
  // Courtyard of the L (around [8,8]) should not sit under a triangle centroid fan.
  // Spot-check: no vertex lands deep in the missing corner.
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = -pos[i + 2];
    assert.ok(!(x > 5 && y > 5), `flat roof leaked into courtyard at ${x},${y}`);
  }
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

const uShape: [number, number][] = [
  [0, 0], [14, 0], [14, 4], [10, 4], [10, 10], [4, 10], [4, 4], [0, 4],
];

test("U footprints decompose into main trunk + wings with lower ridges", () => {
  const parts = decomposeRoofVolumes(uShape);
  assert.ok(parts.length >= 2, `expected multiple volumes, got ${parts.length}`);
  const wings = joinMainAndWings(parts);
  assert.ok(wings.length >= 2);
  assert.ok(wings[0].height >= wings[1].height - 1e-6, "main trunk should be tallest");
  const plan = inferRoofPlan({ footprint: uShape });
  assert.equal(plan.kind, "wings");
  const pos = buildRoofPositions(uShape, {
    shape: "gable",
    ridgeAlong: "depth",
    height: wings[0].height,
    wings: plan.wings,
  });
  assert.ok(pos.length > 60);
});

test("decompose never returns a single twisted volume for an L", () => {
  const parts = decomposeRoofVolumes(ell);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length >= 4);
    assert.equal(p.length, 4, "each volume should be a rectangle");
  }
});
