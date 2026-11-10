import assert from "node:assert/strict";
import test from "node:test";
import {
  aerialPolygonUvs,
  aerialUv,
  aerialUvClamped,
  facadePresetFromMaterial,
  polygonHalfExtent,
  wallRepeat,
} from "./exterior-uv.ts";

test("facadePresetFromMaterial maps common strings", () => {
  assert.equal(facadePresetFromMaterial("red brick"), "brick");
  assert.equal(facadePresetFromMaterial("Vinyl siding"), "vinyl");
  assert.equal(facadePresetFromMaterial("stucco"), "stucco");
  assert.equal(facadePresetFromMaterial("cedar wood clapboard"), "wood");
  assert.equal(facadePresetFromMaterial("concrete block"), "concrete");
  assert.equal(facadePresetFromMaterial("unknown"), "unknown");
  assert.equal(facadePresetFromMaterial(""), "unknown");
});

test("aerialUv puts origin at image center", () => {
  assert.deepEqual(aerialUv(0, 0, 40), [0.5, 0.5]);
  assert.deepEqual(aerialUv(40, 0, 40), [1, 0.5]);
  assert.deepEqual(aerialUv(0, 40, 40), [0.5, 1]);
  assert.deepEqual(aerialUv(-40, -40, 40), [0, 0]);
});

test("aerialUvClamped clamps outside the crop", () => {
  assert.deepEqual(aerialUvClamped(80, -80, 40), [1, 0]);
});

test("aerialPolygonUvs follows vertex order", () => {
  const uvs = aerialPolygonUvs(
    [
      [-20, -20],
      [20, -20],
      [20, 20],
      [-20, 20],
    ],
    40,
  );
  assert.equal(uvs.length, 4);
  assert.deepEqual(uvs[0], [0.25, 0.25]);
  assert.deepEqual(uvs[2], [0.75, 0.75]);
});

test("wallRepeat scales gently with segment size", () => {
  const [u, v] = wallRepeat(10, 2.8, 0.16);
  assert.ok(u > 1.4 && u < 1.8);
  assert.ok(v > 0.35 && v < 0.55);
});

test("polygonHalfExtent grows with footprint", () => {
  const small = polygonHalfExtent([
    [-5, -4],
    [5, -4],
    [5, 4],
    [-5, 4],
  ]);
  const large = polygonHalfExtent([
    [-40, -30],
    [40, -30],
    [40, 30],
    [-40, 30],
  ]);
  assert.ok(large > small);
  assert.ok(small >= 20);
});
