import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessFeatures,
  accessoryReach,
  applyDemPads,
  assembleCompound,
  boxToPolygon,
  buildLotGrade,
  buildingDemPads,
  compoundReach,
  crossVerifySiteFeatures,
  demExtent,
  demHeightfieldBuffers,
  entryStairFeatures,
  expandRing,
  fenceRibbonsFromPolygon,
  foundationExtent,
  foundationSitY,
  gradeHeight,
  MAX_NEIGHBOR_SHELLS,
  MAX_ROAD_FEATURES,
  MAX_ROAD_RIBBONS,
  neighborhoodTerrainFeatures,
  estimateNeighborCloudReach,
  neighborCloudReach,
  neighborReach,
  neighborShellCap,
  neighborShellHeight,
  outdoorReachFromNeighbors,
  outdoorSceneReach,
  pickNeighborHits,
  pointInRing,
  ringSeparation,
  roadReach,
  roadRibbonCap,
  roomBays,
  roadDeckHeight,
  sampleDemCeiling,
  sampleDemHeight,
  smoothHeightSeries,
  SITE_REACH_MAX_M,
  SITE_REACH_MIN_M,
  siteHull,
  siteReach,
  terrainGridLinePositions,
  wallAbutsNeighbor,
  type DemGrid,
} from "./compound-geom.ts";

describe("street and driveway", () => {
  it("detects party walls against neighbor shells", () => {
    const attached: [number, number][] = [[5, -4], [15, -4], [15, 4], [5, 4]];
    // Shared side edge at x=5 — mid-terrace house loses side windows here.
    assert.equal(wallAbutsNeighbor([5, -3], [5, 3], [attached]), true);
    // Street front / back meet the neighbor only at a corner — keep windows.
    assert.equal(wallAbutsNeighbor([-4, -4], [4, -4], [attached]), false);
    assert.equal(wallAbutsNeighbor([-4, 4], [4, 4], [attached]), false);
    assert.equal(wallAbutsNeighbor([-2.5, -4], [2.5, -4], [attached]), false);
    assert.equal(wallAbutsNeighbor([5, -3], [5, 3], []), false);
    // Mid unit with neighbors on both sides.
    const left: [number, number][] = [[-15, -4], [-5, -4], [-5, 4], [-15, 4]];
    assert.equal(wallAbutsNeighbor([-5, -3], [-5, 3], [left, attached]), true);
    assert.equal(wallAbutsNeighbor([5, -3], [5, 3], [left, attached]), true);
  });

  it("counts one window-bay per four meters of depth", () => {
    assert.equal(roomBays(15.3), 4);
    assert.equal(roomBays(9), 2);
  });

  it("runs the driveway from the street to the garage, beside the house", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [{ name: "Simonson Avenue", pts: [[-20, -14], [20, -14]] }],
      garage: [[6, 4], [10, 4], [10, 8], [6, 8]],
    });
    const road = features.find((f) => f.kind === "road");
    const drive = features.find((f) => f.kind === "driveway");
    assert.equal(road?.label, "Simonson Avenue");
    assert.ok(drive);
    const midX = drive!.polygon.reduce((s, p) => s + p[0], 0) / drive!.polygon.length;
    assert.ok(midX > 4, `driveway should sit east of the house, was ${midX}`);
  });

  it("keeps a long road stretch plus a connector and a traffic light at the cross", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [
        { name: "Simonson Avenue", pts: [[-90, -14], [90, -14]] },
        { name: "Cross Street", pts: [[12, -80], [12, 80]] },
      ],
      garage: null,
    });
    const roads = features.filter((f) => f.kind === "road");
    assert.ok(roads.length >= 2, `expected main + connector, got ${roads.length}`);
    const signal = features.find((f) => f.kind === "signal");
    assert.ok(signal, "crossing should spawn a traffic light");
    const c = signal!.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    // Must not sit on the asphalt cross at (12, -14).
    assert.ok(Math.hypot(c[0] - 12, c[1] + 14) > 3, `signal should be curb-offset, got ${c}`);
  });

  it("keeps streets when the clipped run exceeds the old 320 m ribbon cap", () => {
    // siteReach ≥ 200 m → a straight through-street clips to ~400 m and must still draw.
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [
        { name: "Long Avenue", pts: [[-400, -14], [400, -14]] },
        { name: "Side Street", pts: [[20, -400], [20, 400]] },
      ],
      garage: null,
    });
    const roads = features.filter((f) => f.kind === "road");
    assert.ok(roads.length >= 1, `expected long avenue ribbon, got ${roads.length}`);
    assert.ok(features.some((f) => f.kind === "driveway"), "driveway should still attach to the street");
  });

  it("chunks long street runs into short ribbon quads", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [{ name: "Long Avenue", pts: [[-400, -14], [400, -14]] }],
      garage: null,
    });
    const roads = features.filter((f) => f.kind === "road" && f.label === "Long Avenue");
    assert.ok(roads.length >= 3, `expected chunked ribbons, got ${roads.length}`);
    for (const r of roads) {
      const xs = r.polygon.map((p) => p[0]);
      const span = Math.max(...xs) - Math.min(...xs);
      assert.ok(span < 36, `chunk should be short, span=${span}`);
    }
  });

  it("places the nearest mapped fire hydrants around the house", () => {
    const house: [number, number][] = [[-4, -6], [4, -6], [4, 6], [-4, 6]];
    const R = roadReach(house);
    const features = accessFeatures({
      footprint: house,
      streetDir: [0, -1],
      roads: [{ name: "Simonson Avenue", pts: [[-20, -14], [20, -14]] }],
      garage: null,
      hydrants: [
        [8, -12],
        [40, -10],
        [Math.min(70, R - 10), -20],
        [R + 40, 0],
        [-6, -16],
      ],
    });
    const hydrants = features.filter((f) => f.kind === "hydrant");
    assert.equal(hydrants.length, 4, `hydrants outside roadReach (${R} m) should be dropped`);
    assert.equal(hydrants[0].label, "Nearest hydrant");
    const c0 = hydrants[0].polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    assert.ok(Math.hypot(c0[0] - 8, c0[1] + 12) < 0.5 || Math.hypot(c0[0] + 6, c0[1] + 16) < 0.5);
  });

  it("scales site reach with complex size; neighbors tighter than streets", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const campus: [number, number][] = [[-40, -35], [40, -35], [40, 35], [-40, 35]];
    const Rh = siteReach(house);
    const Rc = siteReach(campus);
    assert.ok(Rh >= SITE_REACH_MIN_M && Rh <= SITE_REACH_MAX_M);
    assert.ok(Rc > Rh, "larger footprint should get a wider scene disc");
    assert.ok(Rc <= SITE_REACH_MAX_M);
    assert.ok(neighborReach(campus) < Rc, "neighbor disc stays inside siteReach fetch ceiling");
    assert.ok(roadReach(campus) > neighborReach(campus), "streets reach past the neighbor shell disc");
    assert.ok(roadReach(campus) <= Rc, "street disc stays inside siteReach fetch ceiling");
    assert.equal(compoundReach(house), Rh);
    assert.ok(accessoryReach(house) >= 18, "garage/shed still has a usable lot radius");
    assert.ok(accessoryReach(house) < neighborReach(house), "garage/shed lot radius stays tighter than neighbors");
    assert.ok(accessoryReach(house) < accessoryReach(campus), "small houses keep accessories closer");
    assert.equal(neighborShellCap(house), 15);
    assert.equal(neighborShellCap(campus), 15);
    assert.ok(neighborShellCap(campus) <= MAX_NEIGHBOR_SHELLS);
    assert.ok(roadRibbonCap(campus) > neighborShellCap(campus), "streets keep more runs than neighbor shells");
    assert.ok(neighborReach(campus) < siteReach(campus) * 0.5, "large complexes stay well inside siteReach");
    assert.ok(roadReach(house) > neighborReach(house), "small lots still give streets a bit more room");
    assert.ok(roadReach(house) >= 110, "street disc has a usable floor");
    const estH = estimateNeighborCloudReach(house);
    const estC = estimateNeighborCloudReach(campus);
    assert.ok(estH <= neighborReach(house) && estH >= 40);
    assert.ok(estC >= estH, "larger cap/footprint → larger estimated cloud");
    const closeNbr: [number, number][] = [[12, -3], [20, -3], [20, 3], [12, 3]];
    const farNbr: [number, number][] = [[40, -4], [48, -4], [48, 4], [40, 4]];
    const cloud = neighborCloudReach(house, [closeNbr, farNbr]);
    assert.ok(cloud <= neighborReach(house));
    assert.ok(cloud >= Math.min(neighborReach(house), Math.hypot(48, 4) + 12) - 0.5, "cloud covers farthest kept shell");
    assert.ok(cloud >= estH, "cloud never shrinks below cap-based estimate");
    const outdoor = outdoorReachFromNeighbors(house, [{ kind: "neighbor", polygon: farNbr }]);
    assert.equal(outdoor, outdoorSceneReach(house, [farNbr]));
    assert.ok(outdoor >= cloud, "outdoor disc never shrinks below neighbor cloud");
    assert.equal(outdoor, roadReach(house), "outdoor disc follows roadReach so streets/signs stay");
    // Compact tax lot keeps the obstacle disc smaller than a campus footprint.
    const compactLot: [number, number][] = [[-9, -7], [9, -7], [9, 7], [-9, 7]];
    assert.ok(neighborReach(house, compactLot) < neighborReach(campus));
    assert.ok(neighborReach(house, compactLot) <= siteReach(house));
  });

  it("places mapped stop signs and traffic signals along loaded roads", () => {
    const features = accessFeatures({
      footprint: [[-4, -6], [4, -6], [4, 6], [-4, 6]],
      streetDir: [0, -1],
      roads: [{ name: "Main", pts: [[-80, -14], [80, -14]] }],
      garage: null,
      trafficSignals: [[12, -14], [200, 0]],
      stopSigns: [[-20, -14], [5, 80]],
    });
    const signal = features.find((f) => f.kind === "signal" && f.source === "map");
    const stop = features.find((f) => f.kind === "stop");
    assert.ok(signal, "traffic signal beside the road");
    assert.ok(stop, "stop sign beside the road");
    const sc = signal!.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    const tc = stop!.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
    // Centerline nodes get nudged onto the curb (toward the house at y≈0).
    assert.ok(Math.abs(sc[1] + 14) > 2.5, `signal should leave the roadway centerline, y=${sc[1]}`);
    assert.ok(Math.abs(tc[1] + 14) > 2.5, `stop should leave the roadway centerline, y=${tc[1]}`);
    assert.ok(!features.some((f) => f.kind === "signal" && Math.hypot(f.polygon[0][0] - 200, f.polygon[0][1]) < 5));
    assert.ok(!features.some((f) => f.kind === "stop" && f.polygon.some((p) => Math.abs(p[1] - 80) < 2)));
  });

  it("labels neighbor shells with mapped addresses when available", () => {
    const house: [number, number][] = [[-4, -6], [4, -6], [4, 6], [-4, 6]];
    const nbr: [number, number][] = [[10, -5], [18, -5], [18, 5], [10, 5]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "house", ring: nbr, area: 70, address: "18 Simonson Avenue" },
      ],
      fences: [],
      pools: [],
      parking: [],
      parcel: null,
      aerial: [],
    });
    const n = features.find((f) => f.kind === "neighbor");
    assert.ok(n);
    assert.equal(n!.label, "18 Simonson Avenue");
  });

  it("keeps farther connecting streets but caps road ribbon count", () => {
    const footprint: [number, number][] = [[-4, -6], [4, -6], [4, 6], [-4, 6]];
    const ribbonCap = roadRibbonCap(footprint);
    const roads = [];
    for (let i = 0; i < 40; i++) {
      const y = -20 - i * 4;
      roads.push({ name: `Grid ${i}`, pts: [[-200, y], [200, y]] as [number, number][] });
    }
    const features = accessFeatures({
      footprint,
      streetDir: [0, -1],
      roads,
      garage: null,
    });
    const drawn = features.filter((f) => f.kind === "road");
    const uniqueRuns = new Set(drawn.map((f) => f.label));
    assert.ok(uniqueRuns.size <= ribbonCap, `expected ≤${ribbonCap} street runs, got ${uniqueRuns.size}`);
    assert.ok(uniqueRuns.size <= MAX_ROAD_RIBBONS);
    assert.ok(drawn.length <= MAX_ROAD_FEATURES, `expected ≤${MAX_ROAD_FEATURES} road chunks, got ${drawn.length}`);
    assert.ok(drawn.length >= 8, `neighbor-matched road reach should keep several near ribbons, got ${drawn.length}`);
  });
});

describe("aerial boxes", () => {
  it("puts a centered box on the origin, east to the right and north up", () => {
    const poly = boxToPolygon({ x0: 375, y0: 375, x1: 625, y1: 625 }, 40);
    assert.ok(poly);
    assert.deepEqual(poly![0].map((n) => Math.round(n)), [-10, 10]);
    assert.deepEqual(poly![2].map((n) => Math.round(n)), [10, -10]);
  });

  it("drops a box that covers most of the photo", () => {
    assert.equal(boxToPolygon({ x0: 0, y0: 0, x1: 900, y1: 900 }, 40), null);
  });
});

describe("compound assembly", () => {
  const lot: [number, number][] = [[-8, -6], [12, -6], [12, 28], [-8, 28]];
  const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

  it("keeps the lot and a garage on it, and drops a garage on the next lot", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "garage", ring: [[6, 16], [11, 16], [11, 22], [6, 22]], area: 30 },
        { id: 3, tag: "garage", ring: [[30, 16], [36, 16], [36, 22], [30, 22]], area: 30 },
      ],
      fences: [[[-8, -6], [12, -6]]],
      pools: [],
      parcel: lot,
      aerial: [
        { kind: "patio", polygon: [[-4, 10], [2, 10], [2, 16], [-4, 16]] },
        { kind: "driveway", polygon: [[-2, -20], [3, -20], [3, -28], [-2, -28]] },
        { kind: "garage", label: "Aerial garage", polygon: [[6.5, 16.5], [10, 16.5], [10, 21], [6.5, 21]] },
      ],
    });
    assert.ok(features.some((f) => f.kind === "yard"));
    assert.equal(features.filter((f) => f.kind === "garage").length, 1);
    assert.equal(features.find((f) => f.kind === "garage")!.source, "map");
    assert.equal(features.filter((f) => f.kind === "patio").length, 1);
    assert.equal(features.filter((f) => f.kind === "driveway").length, 0);
    assert.ok(features.some((f) => f.kind === "fence"));
    assert.ok(pointInRing([0, 20], lot));
  });

  it("builds a site hull when there is no tax lot, and keeps a rear garage", () => {
    const bigHouse: [number, number][] = [[-20, -15], [20, -15], [20, 15], [-20, 15]];
    assert.ok(compoundReach(bigHouse) > 60);
    assert.ok(accessoryReach(bigHouse) < compoundReach(bigHouse));
    assert.ok(foundationExtent(bigHouse) > 20);
    const garage: [number, number][] = [[8, 40], [16, 40], [16, 50], [8, 50]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: bigHouse,
      structures: [
        { id: 1, tag: "yes", ring: bigHouse, area: 1200 },
        { id: 2, tag: "garage", ring: garage, area: 80 },
      ],
      fences: [],
      pools: [],
      parking: [[[-15, -30], [15, -30], [15, -22], [-15, -22]]],
      parcel: null,
      aerial: [],
    });
    assert.ok(features.some((f) => f.kind === "yard"));
    assert.ok(features.some((f) => f.kind === "garage"));
    assert.ok(features.some((f) => f.kind === "driveway" && f.label === "Parking"));
  });

  it("draws attached next-door houses as ghost neighbor shells, not garages", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const attached: [number, number][] = [[5, -4], [15, -4], [15, 4], [5, 4]];
    // Beyond the shared outdoor scene radius.
    const far: [number, number][] = [[320, -4], [330, -4], [330, 4], [320, 4]];
    assert.ok(siteReach(house) >= SITE_REACH_MIN_M);
    assert.ok(siteReach(house) <= SITE_REACH_MAX_M);
    assert.ok(neighborReach(house) >= accessoryReach(house));
    assert.ok(roadReach(house) > neighborReach(house));
    assert.ok(roadReach(house) <= siteReach(house));
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "house", ring: attached, area: 80, levels: 2 },
        { id: 3, tag: "residential", ring: far, area: 90 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      mainEaveHeight: 5.4,
    });
    const neighbors = features.filter((f) => f.kind === "neighbor");
    assert.equal(neighbors.length, 1);
    assert.ok(neighbors[0].polygon.some(([x]) => x > 5));
    assert.ok(Math.abs(neighbors[0].height - 5.5) < 0.2, `2-level neighbor should be ~5.5 m, got ${neighbors[0].height}`);
    assert.equal(features.filter((f) => f.kind === "garage" && f.polygon.some(([x]) => x > 5 && x < 20)).length, 0);
  });

  it("lays graded terrain pads under the house and each neighbor", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const nbr: [number, number][] = [[12, -4], [22, -4], [22, 4], [12, 4]];
    const grown = expandRing(house, 2);
    assert.ok(grown.every((p, i) => Math.hypot(p[0], p[1]) > Math.hypot(house[i][0], house[i][1]) - 0.01));
    const pads = neighborhoodTerrainFeatures(house, [nbr]);
    assert.equal(pads.filter((f) => f.id === "terrain-main").length, 0, "no solid house pad");
    assert.ok(pads.some((f) => f.id.startsWith("terrain-nbr")));
    assert.ok(pads.some((f) => f.id === "terrain-radius"));
    const disc = pads.find((f) => f.id === "terrain-radius")!;
    const reach = neighborReach(house);
    const extent = Math.max(...disc.polygon.map(([x, y]) => Math.hypot(x, y)));
    assert.ok(extent >= reach * 0.9, `radius disc should reach ~${reach} m, got ${extent}`);
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "house", ring: nbr, area: 80 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
    });
    const terrain = features.filter((f) => f.kind === "terrain");
    assert.ok(terrain.length >= 2, `expected radius + neighbor pads, got ${terrain.length}`);
    assert.equal(terrain.filter((f) => f.id === "terrain-main").length, 0);
  });

  it("keeps every house-like building inside the neighbor radius around the focus house", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const across: [number, number][] = [[-5, -35], [5, -35], [5, -28], [-5, -28]];
    const side: [number, number][] = [[25, -4], [35, -4], [35, 4], [25, 4]];
    const r = siteReach(house);
    assert.ok(r >= SITE_REACH_MIN_M);
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [
        { id: 1, tag: "house", ring: house, area: 80 },
        { id: 2, tag: "house", ring: across, area: 70 },
        { id: 3, tag: "residential", ring: side, area: 85 },
        { id: 4, tag: "yes", ring: [[40, 10], [48, 10], [48, 18], [40, 18]], area: 64 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
      mainEaveHeight: 5.4,
    });
    const neighbors = features.filter((f) => f.kind === "neighbor");
    assert.ok(neighbors.length >= 3, `expected across/side/yes within ${r} m, got ${neighbors.length}`);
  });

  it("caps neighbor shells to neighborShellCap (nearest first)", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const cap = neighborShellCap(house);
    const reach = neighborReach(house);
    const structures = [{ id: 1, tag: "house", ring: house, area: 80 }];
    // Pack many house-like pads in a ring inside neighborReach so the max-count clamp fires.
    for (let i = 0; i < cap + 8; i++) {
      const ang = (i / (cap + 8)) * Math.PI * 2;
      const d = Math.min(reach * 0.55, 14 + (i % 3) * 3);
      const cx = Math.cos(ang) * d;
      const cy = Math.sin(ang) * d;
      structures.push({
        id: i + 2,
        tag: "house",
        ring: [[cx - 1.4, cy - 1.4], [cx + 1.4, cy - 1.4], [cx + 1.4, cy + 1.4], [cx - 1.4, cy + 1.4]],
        area: 50,
      });
    }
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures,
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
    });
    const neighbors = features.filter((f) => f.kind === "neighbor");
    assert.equal(neighbors.length, cap);
    assert.ok(cap <= MAX_NEIGHBOR_SHELLS);
  });

  it("keeps only the nearest neighbors when the cap binds", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const cap = neighborShellCap(house);
    const structures = [{ id: 1, tag: "house", ring: house, area: 80 }];
    // Close ring fills the cap; far peers sit well beyond it.
    const reach = neighborReach(house);
    for (let i = 0; i < cap + 4; i++) {
      const ang = (i / (cap + 4)) * Math.PI * 2;
      const d = Math.min(reach * 0.5, 12 + (i % 4) * 2);
      const cx = Math.cos(ang) * d;
      const cy = Math.sin(ang) * d;
      structures.push({
        id: 100 + i,
        tag: "house",
        ring: [[cx - 1.2, cy - 1.2], [cx + 1.2, cy - 1.2], [cx + 1.2, cy + 1.2], [cx - 1.2, cy + 1.2]],
        area: 50,
      });
    }
    structures.push(
      { id: 2, tag: "house", ring: [[-4, 50], [4, 50], [4, 56], [-4, 56]], area: 70 },
      { id: 3, tag: "house", ring: [[-55, -3], [-48, -3], [-48, 3], [-55, 3]], area: 70 },
      { id: 4, tag: "house", ring: [[-4, -56], [4, -56], [4, -50], [-4, -50]], area: 70 },
    );
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures,
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
    });
    const neighbors = features.filter((f) => f.kind === "neighbor");
    assert.equal(neighbors.length, cap);
    assert.equal(neighbors.some((f) => f.id === "neighbor-2"), false, "far north peer should drop");
    assert.equal(neighbors.some((f) => f.id === "neighbor-3"), false, "far west peer should drop");
    assert.equal(neighbors.some((f) => f.id === "neighbor-4"), false, "far south peer should drop");
    assert.ok(neighbors.every((f) => Number(f.id.replace("neighbor-", "")) >= 100), "only close ring peers stay");
    const hits = structures
      .filter((s) => s.id !== 1)
      .map((s) => ({
        s,
        d: Math.hypot(
          s.ring.reduce((a, p) => a + p[0], 0) / s.ring.length,
          s.ring.reduce((a, p) => a + p[1], 0) / s.ring.length,
        ),
      }));
    const picked = pickNeighborHits(hits, 4, [0, 0]);
    assert.equal(picked.length, 4);
    for (let i = 1; i < picked.length; i++) {
      assert.ok(picked[i - 1]!.d <= picked[i]!.d, "picked order is nearest-first");
    }
    assert.ok(picked.every((h) => h.s.id >= 100), "helper keeps nearest close peers");
  });

  it("sizes neighbor shells from OSM levels/height or the focus house eave", () => {
    assert.equal(neighborShellHeight({ levels: 3, mainEave: 5.4 }), 8.25);
    assert.ok(Math.abs(neighborShellHeight({ heightM: 10, mainEave: 5.4 }) - 8.8) < 0.05);
    assert.equal(neighborShellHeight({ mainEave: 5.4 }), 5.4);
    const wide: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const ranch: [number, number][] = [[5, -4], [25, -4], [25, 4], [5, 4]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: wide,
      structures: [
        { id: 1, tag: "house", ring: wide, area: 80 },
        { id: 2, tag: "house", ring: ranch, area: 400 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      mainEaveHeight: 2.8,
    });
    const n = features.find((f) => f.kind === "neighbor");
    assert.ok(n);
    assert.ok(n!.height <= 4, `wide ranch without levels should match 1-story eave, got ${n!.height}`);
  });

  it("scales accessory reach with foundation size and drops far campus buildings", () => {
    const cottage: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const campus: [number, number][] = [[-40, -30], [40, -30], [40, 30], [-40, 30]];
    assert.ok(accessoryReach(cottage) < accessoryReach(campus));
    const hugeLot: [number, number][] = [[-80, -80], [80, -80], [80, 80], [-80, 80]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: cottage,
      structures: [
        { id: 1, tag: "house", ring: cottage, area: 80 },
        { id: 2, tag: "yes", ring: [[6, 8], [12, 8], [12, 14], [6, 14]], area: 36 },
        { id: 3, tag: "yes", ring: [[50, 40], [62, 40], [62, 55], [50, 55]], area: 180 },
        { id: 4, tag: "garage", ring: [[55, -10], [62, -10], [62, -4], [55, -4]], area: 40 },
      ],
      fences: [],
      pools: [],
      parcel: hugeLot,
      aerial: [],
    });
    const outs = features.filter((f) => f.kind === "garage" || f.kind === "shed");
    assert.ok(outs.length >= 1, "near accessory on the lot should stay");
    assert.ok(
      !outs.some((f) => f.polygon.some(([x]) => x > 40)),
      "far campus buildings outside accessory reach must not render as garages",
    );
  });

  it("pads a convex hull around the house and garage", () => {
    const hull = siteHull(
      [
        [[-5, -4], [5, -4], [5, 4], [-5, 4]],
        [[6, 16], [11, 16], [11, 22], [6, 22]],
      ],
      3,
    );
    assert.ok(hull && hull.length >= 4);
    assert.ok(pointInRing([0, 0], hull!));
    assert.ok(pointInRing([8, 19], hull!));
  });

  it("cross-verify keeps OSM garage when aerial agrees and fills a missing driveway", () => {
    const features = crossVerifySiteFeatures({
      features: [
        {
          id: "g1",
          kind: "garage",
          label: "Garage",
          polygon: [[6, 16], [11, 16], [11, 22], [6, 22]],
          height: 2.6,
          source: "map",
        },
      ],
      aerialCues: [
        {
          kind: "garage",
          label: "Garage",
          polygon: [[6.5, 16.5], [10.5, 16.5], [10.5, 21.5], [6.5, 21.5]],
          confidence: 0.7,
        },
        {
          kind: "driveway",
          label: "Driveway",
          polygon: [[-2, -12], [2, -12], [2, -20], [-2, -20]],
          confidence: 0.55,
        },
      ],
      geminiGarage: "detached",
    });
    assert.ok(features.some((f) => f.kind === "garage" && f.source === "map"));
    assert.ok(features.some((f) => f.kind === "driveway" && f.source === "aerial"));
  });

  it("keeps a large attached wing even when its centroid is far from the focus wall", () => {
    const focus: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    // 40 m deep wing sharing the east wall — centroid sits ~20 m out.
    const wing: [number, number][] = [[5, -4], [45, -4], [45, 4], [5, 4]];
    assert.equal(ringSeparation(focus, wing), 0);
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: focus,
      structures: [
        { id: 1, tag: "house", ring: focus, area: 80 },
        { id: 2, tag: "yes", ring: wing, area: 160 },
      ],
      fences: [],
      pools: [],
      parcel: null,
      aerial: [],
      streetDir: [0, -1],
      mainEaveHeight: 5.4,
    });
    assert.ok(features.some((f) => f.kind === "neighbor"), "touching building=yes wing should be a neighbor shell");
  });

  it("adds neighbor backyard fences/trees and keeps mapped fences on the neighbor lot", () => {
    const focus: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const nbr: [number, number][] = [[8, -4], [18, -4], [18, 4], [8, 4]];
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: focus,
      structures: [
        { id: 1, tag: "house", ring: focus, area: 80 },
        { id: 2, tag: "house", ring: nbr, area: 80 },
      ],
      fences: [[[20, 6], [20, 16]]],
      pools: [[[10, 10], [16, 10], [16, 14], [10, 14]]],
      parcel: [[-8, -8], [8, -8], [8, 8], [-8, 8]],
      aerial: [],
      streetDir: [0, -1],
      trees: [[12, 12]],
      mainEaveHeight: 5.4,
    });
    assert.ok(features.some((f) => f.kind === "neighbor"));
    assert.ok(features.some((f) => f.kind === "fence" && f.source === "map"), "fence beside neighbor should stay");
    assert.ok(features.some((f) => f.kind === "pool"), "neighbor backyard pool should stay");
    assert.ok(features.some((f) => f.kind === "trees" && f.source === "map"));
    assert.ok(
      features.some((f) => f.kind === "fence" && f.source === "estimated" && f.id.includes("nbr")),
      "empty neighbor rear should get estimated fence",
    );
  });

  it("tilts the lot downhill toward the street and builds entry stairs to the slab", () => {
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const grade = buildLotGrade(house, [0, -1]);
    assert.ok(grade);
    assert.ok(gradeHeight([0, -10], grade) < gradeHeight([0, 0], grade), "street side should sit lower");
    assert.ok(Math.abs(gradeHeight([0, 0], grade)) < 0.05, "house origin stays near slab");
    const steps = entryStairFeatures({
      streetDir: [0, -1],
      grade,
      exits: [[0, -4]],
    });
    assert.ok(steps.length >= 2, `expected entry treads, got ${steps.length}`);
    assert.ok(steps.every((s) => s.kind === "steps" && s.source === "estimated"));
    const tops = steps.map((s) => s.height).sort((a, b) => a - b);
    assert.ok(tops[0] < tops[tops.length - 1], "treads rise toward the door");
    assert.ok(Math.abs(tops[tops.length - 1]) < 0.08, "top tread meets the slab");
  });

  it("prefers DEM samples over the plane grade and builds a heightfield mesh", () => {
    // 3×3 grid: flat slab at origin, street (−y) 4 m lower, backyard (+y) 2 m higher.
    const dem: DemGrid = {
      x0: -20,
      y0: -20,
      cell: 20,
      cols: 3,
      rows: 3,
      z: [
        -4, -4, -4, // y = -20
        0, 0, 0, // y = 0
        2, 2, 2, // y = 20
      ],
      source: "test-dem",
    };
    const plane = buildLotGrade(
      [[-5, -4], [5, -4], [5, 4], [-5, 4]],
      [0, -1],
    );
    assert.ok(plane);
    const grade = { ...plane!, dem };
    assert.ok(grade.dem);
    assert.ok(Math.abs(gradeHeight([0, 0], grade)!) < 0.05, "slab stays near 0");
    assert.ok(gradeHeight([0, -20], grade)! < -3.5, "street side follows DEM drop");
    assert.ok(gradeHeight([0, 20], grade)! > 1.5, "backyard follows DEM rise");
    // Plane alone would be tiny (~0.7 m at 20 m); DEM must dominate.
    assert.ok(Math.abs(gradeHeight([0, -20], grade)!) > 3, "DEM not plane");
    const atCorner = sampleDemHeight([10, 10], dem);
    assert.ok(atCorner != null && atCorner > 0.5 && atCorner < 1.5);
    const ext = demExtent(grade);
    assert.deepEqual(ext, { min: -4, max: 2 });
    const buf = demHeightfieldBuffers(dem, { radiusM: 25 });
    assert.ok(buf);
    assert.equal(buf!.positions.length, 3 * 3 * 3);
    assert.ok(buf!.indices.length >= 6);
    const house: [number, number][] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
    const nbr: [number, number][] = [[-5, -28], [5, -28], [5, -20], [-5, -20]];
    const sit = foundationSitY(nbr, grade);
    assert.ok(sit < -2, `neighbor on street DEM should sit below slab, got ${sit}`);
    assert.ok(
      foundationSitY(nbr, grade, 0.2) <= sit + 1e-9,
      "low-percentile sit stays ≤ median (median is the default)",
    );
    const pads = buildingDemPads(house, [nbr], grade);
    assert.equal(pads.length, 2);
    assert.equal(pads[0]!.y, 0);
    assert.ok(Math.abs(applyDemPads(2, [0, 0], pads, dem.cell) - 0) < 1e-6, "focus pad flattens slab");
    assert.ok(
      Math.abs(applyDemPads(-4, [0, -24], pads, dem.cell) - pads[1]!.y) < 1e-6,
      "neighbor pad shelves under shell",
    );
    const atWall = applyDemPads(-4, [0, -4.01], pads, dem.cell);
    assert.ok(Math.abs(atWall) < 0.15, `wall join should match slab, got ${atWall}`);
    const midBand = applyDemPads(-4, [0, -12], pads, dem.cell);
    assert.ok(Math.abs(midBand + 4) < 1.2, `mid-band should keep natural DEM, got ${midBand}`);
    const padded = demHeightfieldBuffers(dem, { radiusM: 40, pads });
    assert.ok(padded);
    assert.ok(Math.abs(padded!.positions[4 * 3 + 1]!) < 0.1, "padded DEM sits at slab under house");
    // Stairs should climb from DEM street grade up to the slab.
    const steps = entryStairFeatures({
      streetDir: [0, -1],
      grade,
      exits: [[0, -4]],
    });
    assert.ok(steps.length >= 3, `DEM drop should need more treads, got ${steps.length}`);
    const grid = terrainGridLinePositions(grade, 40, 4, { subdivide: 2 });
    assert.ok(grid.length >= 6 * 2 * 4 * 4, "warped grid should emit subdivided segments");
    // Y values must vary with DEM (not a flat table).
    const ys = Array.from({ length: grid.length / 3 }, (_, i) => grid[i * 3 + 1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 2, "grid should follow DEM relief");
    // Soft deck: above bilinear, but not snapped to the full cell-corner max (that spiked roads).
    const mid: [number, number] = [0, -10];
    const bil = sampleDemHeight(mid, dem)!;
    const ceil = sampleDemCeiling(mid, dem)!;
    const deck = roadDeckHeight(mid, grade);
    assert.ok(ceil >= bil - 1e-9);
    assert.ok(deck > bil, "deck lifts above bilinear DEM");
    assert.ok(deck <= ceil + 1e-9, "deck stays at/below cell ceiling");
    assert.ok(deck < bil + (ceil - bil) * 0.9 + 0.01 || ceil - bil < 0.05, "deck does not hard-snap to ceiling");
    const spiked = [0, 0, 4, 0, 0];
    const smoothed = smoothHeightSeries(spiked, 2);
    assert.ok(smoothed[2]! < 2.5, `along-rail blur should kill a lone spike, got ${smoothed[2]}`);
  });

  it("infers a backyard fence and trees when the rear lot is empty", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [],
      pools: [],
      parcel: lot,
      aerial: [],
      streetDir: [0, -1],
      trees: [],
    });
    const estFences = features.filter((f) => f.kind === "fence" && f.source === "estimated");
    const estTrees = features.filter((f) => f.kind === "trees" && f.source === "estimated");
    assert.ok(estFences.length >= 2, `expected rear fence segments, got ${estFences.length}`);
    assert.ok(estTrees.length >= 2, `expected backyard trees, got ${estTrees.length}`);
    for (const t of estTrees) {
      const c = t.polygon.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / 4);
      assert.ok(c[1] > 0, "estimated trees should sit behind the house (+y)");
    }
  });

  it("turns elongated aerial boxes into fence ribbons and keeps aerial backyard fences", () => {
    const longBox: [number, number][] = [[-6, 12], [8, 12], [8, 12.6], [-6, 12.6]];
    const ribbons = fenceRibbonsFromPolygon(longBox);
    assert.ok(ribbons.length >= 1, "long box should yield at least one ribbon");
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [],
      pools: [],
      parcel: lot,
      aerial: [{ kind: "fence", label: "Hedge", polygon: longBox }],
      streetDir: [0, -1],
      trees: [],
    });
    assert.ok(
      features.some((f) => f.kind === "fence" && f.source === "aerial"),
      "aerial fence cue should become a fence feature",
    );
  });

  it("fills sparse backyard with parcel-edge estimated fences", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [],
      pools: [],
      parcel: lot,
      aerial: [],
      streetDir: [0, -1],
      trees: [],
    });
    const est = features.filter((f) => f.kind === "fence" && f.source === "estimated");
    assert.ok(est.length >= 1, `expected parcel-edge fences, got ${est.length}`);
  });

  it("keeps mapped backyard trees and skips inferred fill when fences already cover the rear", () => {
    const { features } = assembleCompound({
      mainId: 1,
      mainRing: house,
      structures: [{ id: 1, tag: "house", ring: house, area: 80 }],
      fences: [
        [[-8, 10], [-8, 28]],
        [[-8, 28], [12, 28]],
        [[12, 28], [12, 10]],
      ],
      pools: [],
      parcel: lot,
      aerial: [],
      streetDir: [0, -1],
      trees: [[0, 18], [4, 20]],
    });
    assert.ok(features.some((f) => f.kind === "trees" && f.source === "map"));
    assert.equal(features.filter((f) => f.kind === "trees" && f.source === "estimated").length, 0);
    assert.equal(features.filter((f) => f.kind === "fence" && f.source === "estimated").length, 0);
    assert.ok(features.filter((f) => f.kind === "fence" && f.source === "map").length >= 3);
  });
});
