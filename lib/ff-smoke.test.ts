import { describe, expect, it } from "vitest";
import { colonialTemplate } from "./templates";
import { computeSizeUp } from "./sizeup";
import { planHoseLays } from "./hose-lay";
import { scoreRooms } from "./structural-risk";
import { buildVentGraph, smokeLikelyStacks } from "./vent-paths";
import { buildNav, dualEgress, stairCutOff } from "./route";
import type { BuildingModel, CompoundFeature, Marker } from "../packages/schema/building-model";

/** Mirrors lib/demo.ts enrichment so /model/demo tactics stay covered under vitest (no @/ alias). */
function demoLikeModel(): BuildingModel {
  const stamped = "2026-01-01T00:00:00Z";
  const box = (x0: number, y0: number, x1: number, y1: number): CompoundFeature["polygon"] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const features: CompoundFeature[] = [
    { id: "demo-road", kind: "road", label: "Demo Street", polygon: box(-40, -14, 40, -10), height: 0.05, source: "estimated" },
    { id: "demo-driveway", kind: "driveway", label: "Driveway", polygon: box(4, -10, 7, -4.5), height: 0.04, source: "estimated" },
    { id: "hydrant-0", kind: "hydrant", label: "Nearest hydrant", polygon: box(14, -13.2, 14.6, -12.6), height: 0.85, source: "estimated" },
    { id: "hydrant-1", kind: "hydrant", label: "Hydrant #2", polygon: box(-18, -13.2, -17.4, -12.6), height: 0.85, source: "estimated" },
    { id: "hydrant-2", kind: "hydrant", label: "Hydrant #3", polygon: box(28, -5, 28.6, -4.4), height: 0.85, source: "estimated" },
    { id: "nbr-east", kind: "neighbor", label: "East exposure", polygon: box(10, -4, 18, 4), height: 8, source: "estimated" },
  ];
  const markers: Marker[] = [
    { id: "demo-panel-main", type: "shutoff", floor: -1, pos: [5.15, -3.4], note: "Main electrical panel — basement utility", createdAt: stamped },
    { id: "demo-gas-meter", type: "shutoff", floor: 0, pos: [-5.35, -4.55], note: "Exterior gas meter / shutoff (street side)", createdAt: stamped },
  ];
  const base = colonialTemplate({
    id: "demo",
    lat: 42.7298,
    lng: -73.6789,
    address: "Demo house — Troy, NY",
    source: "demo",
    confidence: 0.5,
  });
  return {
    ...base,
    markers,
    interior: {
      status: "verified",
      source: "demo template",
      reasons: [],
      knownLevels: base.floors.map((f) => f.level),
      notes: [],
    },
    compound: { features, basis: "demo-tactics-v1" },
  };
}

describe("demoModel FF tactics smoke", () => {
  const model = demoLikeModel();
  const fire: Marker = {
    id: "t-fire",
    type: "fire",
    floor: 0,
    pos: [-4, 3],
    note: "Living room fire",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("size-up: stories, shutoffs, hydrants, dual egress", () => {
    const s = computeSizeUp(model, [...model.markers, fire]);
    expect(s.stories).toBe(2);
    expect(s.basement).toBe(true);
    expect(s.shutoffs.length).toBeGreaterThanOrEqual(2);
    expect(s.hydrants.length).toBe(3);
    expect(s.exposures.length).toBeGreaterThanOrEqual(1);
    expect(s.egress.primary).toBeTruthy();
    expect(s.egress.secondary).toBeTruthy();
    expect(s.egress.primary!.doorId).not.toBe(s.egress.secondary!.doorId);
    expect(s.summaryLine.length).toBeGreaterThan(20);
  });

  it("dual egress + cut-off APIs", () => {
    const nav = buildNav(model);
    const d = dualEgress(nav, fire);
    expect(d.primary).toBeTruthy();
    expect(d.secondary).toBeTruthy();
    expect(stairCutOff(nav, [fire])).toBe(false);
  });

  it("hose-lay: ranked hydrant stretches with load hints", () => {
    const lays = planHoseLays(model);
    expect(lays.length).toBe(3);
    expect(lays[0].rank).toBe(0);
    expect(lays[0].lengthFt).toBeGreaterThan(0);
    expect(lays[0].path.length).toBeGreaterThanOrEqual(2);
    expect(["200ft", "300ft", "long"]).toContain(lays[0].loadHint);
    expect(lays[0].lengthM).toBeLessThanOrEqual(lays[1].lengthM);
  });

  it("structure risk: scores every room", () => {
    const risks = scoreRooms(model);
    expect(risks.length).toBeGreaterThan(5);
    for (const r of risks) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("vent paths: multi-floor stair stack", () => {
    const g = buildVentGraph(model);
    expect(g.stacks.length).toBeGreaterThan(0);
    const smoke = smokeLikelyStacks(g, 0);
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke.some((s) => s.levels.length >= 2)).toBe(true);
  });
});
