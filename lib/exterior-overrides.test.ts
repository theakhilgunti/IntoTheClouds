import assert from "node:assert/strict";
import test from "node:test";
import { exteriorOverrideForAddress } from "./exterior-overrides.ts";

test("Schuyler override prefers tiles + vinyl", () => {
  const o = exteriorOverrideForAddress("17 Schuyler Ave, Latham, NY");
  assert.ok(o);
  assert.equal(o!.preferTiles, true);
  assert.equal(o!.facadePreset, "vinyl");
});

test("BARH override is concrete and hides neighbors", () => {
  const o = exteriorOverrideForAddress("BARH Residence Hall, Troy, NY");
  assert.ok(o);
  assert.equal(o!.facadePreset, "concrete");
  assert.equal(o!.hideNeighbors, true);
});

test("unpinned address has no override", () => {
  assert.equal(exteriorOverrideForAddress("999 Nowhere St, Troy, NY"), null);
});

test("East Hills Blvd override is brick + tiles", () => {
  const o = exteriorOverrideForAddress("3 East Hills Boulevard, Loudonville, NY");
  assert.ok(o);
  assert.equal(o!.facadePreset, "brick");
  assert.equal(o!.preferTiles, true);
});

test("boulevard normalizes to blvd for override key", () => {
  const a = exteriorOverrideForAddress("3 East Hills Blvd, Albany, NY 12211");
  const b = exteriorOverrideForAddress("3 East Hills Boulevard, Albany, NY 12211");
  assert.ok(a && b);
  assert.equal(a!.facadePreset, b!.facadePreset);
});

test("census-style E HILLS BLVD matches East Hills override", () => {
  const o = exteriorOverrideForAddress("3 E HILLS BLVD, LOUDONVILLE, NY, 12211");
  assert.ok(o);
  assert.equal(o!.facadePreset, "brick");
});

test("1 Andover DR gets vinyl override", () => {
  const o = exteriorOverrideForAddress("1 ANDOVER DR, ALBANY, NY, 12211");
  assert.ok(o);
  assert.equal(o!.facadePreset, "vinyl");
});
