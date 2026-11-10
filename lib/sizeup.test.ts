import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeSizeUp } from "./sizeup";
import type { BuildingModel, Marker } from "../packages/schema/building-model";

const raw = JSON.parse(readFileSync(new URL("../public/demo/demo-house.json", import.meta.url), "utf8"));
const base = (raw.model ?? raw) as BuildingModel;

const fireOnStair: Marker = {
  id: "fire-stair",
  type: "fire",
  floor: 0,
  pos: [0, 2.25],
  note: "Stairwell fire",
  createdAt: "2026-01-01T00:00:00Z",
};

const fireRoom: Marker = {
  id: "fire-room",
  type: "fire",
  floor: 0,
  pos: [-4, 3],
  note: "Living room",
  createdAt: "2026-01-01T00:00:00Z",
};

const gasShutoff: Marker = {
  id: "so-gas",
  type: "shutoff",
  floor: 0,
  pos: [-5, -3],
  note: "Gas meter street side",
  createdAt: "2026-01-01T00:00:00Z",
};

const elecShutoff: Marker = {
  id: "so-elec",
  type: "shutoff",
  floor: 0,
  pos: [5, -3],
  note: "Electric panel / breaker",
  createdAt: "2026-01-01T00:00:00Z",
};

function withCompound(model: BuildingModel): BuildingModel {
  return {
    ...model,
    compound: {
      features: [
        {
          id: "hydrant-0",
          kind: "hydrant",
          label: "Nearest hydrant",
          polygon: [
            [12, -6],
            [12.5, -6],
            [12.5, -5.5],
            [12, -5.5],
          ],
          height: 0.85,
          source: "map",
        },
        {
          id: "hydrant-1",
          kind: "hydrant",
          label: "Fire hydrant",
          polygon: [
            [30, 10],
            [30.5, 10],
            [30.5, 10.5],
            [30, 10.5],
          ],
          height: 0.85,
          source: "map",
        },
        {
          id: "nbr-1",
          kind: "neighbor",
          label: "East neighbor",
          polygon: [
            [10, -4],
            [18, -4],
            [18, 4],
            [10, 4],
          ],
          height: 8,
          source: "map",
        },
      ],
      basis: "test",
    },
  };
}

describe("computeSizeUp", () => {
  it("demo house is 2-story with basement", () => {
    const s = computeSizeUp(base, []);
    expect(s.stories).toBe(2);
    expect(s.basement).toBe(true);
    expect(s.interiorStatus).toBe("verified");
    expect(s.summaryLine).toMatch(/2-story with basement/i);
  });

  it("hydrants and exposures sort by distance and cap at 3 hydrants", () => {
    const s = computeSizeUp(withCompound(base), []);
    expect(s.hydrants).toHaveLength(2);
    expect(s.hydrants[0].distM).toBeLessThan(s.hydrants[1].distM);
    expect(s.hydrants[0].label).toBe("Nearest hydrant");
    expect(s.exposures).toHaveLength(1);
    expect(s.exposures[0].label).toBe("East neighbor");
    expect(s.exposures[0].distM).toBeGreaterThan(0);
  });

  it("shutoffs classify gas vs electric from note", () => {
    const s = computeSizeUp(base, [gasShutoff, elecShutoff]);
    expect(s.shutoffs).toHaveLength(2);
    expect(s.shutoffs.some((x) => x.kind === "gas")).toBe(true);
    expect(s.shutoffs.some((x) => x.kind === "electric")).toBe(true);
  });

  it("dual egress: primary front door, secondary back door", () => {
    const s = computeSizeUp(base, [fireRoom]);
    expect(s.egress.primary).toBeTruthy();
    expect(s.egress.primary!.doorId).toBe("g-d-front");
    expect(s.egress.secondary).toBeTruthy();
    expect(s.egress.secondary!.doorId).toBe("g-d-back");
    expect(s.egress.primary!.doorId).not.toBe(s.egress.secondary!.doorId);
    expect(s.egress.cutOff).toBe(false);
  });

  it("fire in the only stair sets cutOff", () => {
    const s = computeSizeUp(base, [fireOnStair]);
    expect(s.egress.cutOff).toBe(true);
    expect(s.summaryLine).toMatch(/STAIR CUT-OFF/);
  });

  it("estimated interior status passes through", () => {
    const guessed = {
      ...base,
      interior: { status: "estimated" as const, reasons: [], knownLevels: [], notes: [] },
    };
    const s = computeSizeUp(guessed, []);
    expect(s.interiorStatus).toBe("estimated");
  });

  it("without fire/victim still shows dual egress from a default room", () => {
    const s = computeSizeUp(base, []);
    expect(s.egress.primary).toBeTruthy();
    expect(s.egress.secondary).toBeTruthy();
    expect(s.egress.primary!.doorId).not.toBe(s.egress.secondary!.doorId);
  });
});
