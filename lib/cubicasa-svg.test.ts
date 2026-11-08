import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeCubiCasaSvg, readCubiCasaSvg } from "./cubicasa-svg.ts";

const SAMPLE = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" width="200" height="160">
  <g id="Wall"><polygon points="10,10 190,10 190,20 10,20"/></g>
  <g class="Space LivingRoom"><polygon points="20,30 100,30 100,90 20,90"/></g>
  <g class="Space Kitchen"><polygon points="100,30 180,30 180,90 100,90"/></g>
  <g class="Space Bedroom"><polygon points="20,90 100,90 100,150 20,150"/></g>
  <g class="Space Bath"><polygon points="100,90 140,90 140,150 100,150"/></g>
  <g class="Space HallWay"><polygon points="140,90 180,90 180,150 140,150"/></g>
  <g id="Door"><polygon points="95,85 105,85 105,95 95,95"/></g>
</svg>`;

describe("readCubiCasaSvg", () => {
  it("detects CubiCasa Space annotations", () => {
    assert.equal(looksLikeCubiCasaSvg(SAMPLE), true);
    assert.equal(looksLikeCubiCasaSvg("<svg></svg>"), false);
  });

  it("parses rooms into a PlanRead grid", () => {
    const plan = readCubiCasaSvg(SAMPLE);
    assert.equal(plan.readable, true);
    assert.ok(plan.rooms.length >= 5);
    assert.ok(plan.rooms.some((r) => r.type === "living"));
    assert.ok(plan.rooms.some((r) => r.type === "kitchen"));
    assert.ok(plan.rooms.some((r) => r.type === "bedroom"));
    assert.ok(plan.rooms.some((r) => r.type === "bathroom"));
    assert.ok(plan.rooms.some((r) => r.type === "hallway"));
    assert.ok(plan.doors.length >= 1);
    assert.ok(plan.confidence >= 0.8);
    for (const r of plan.rooms) {
      assert.equal(r.box.length, 4);
      assert.ok(r.box[2] > r.box[0] && r.box[3] > r.box[1]);
    }
  });

  it("rejects empty SVG", () => {
    const plan = readCubiCasaSvg(`<svg viewBox="0 0 10 10"><g id="Wall"><polygon points="0,0 10,0 10,1 0,1"/></g></svg>`);
    assert.equal(plan.readable, false);
    assert.ok(plan.problems.length > 0);
  });
});
