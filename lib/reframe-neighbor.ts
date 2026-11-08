/**
 * Instant neighbor switch: reframe the already-built compound around a nearby shell
 * instead of re-running the full scan pipeline.
 */
import type {
  BuildingModel,
  CompoundFeature,
  DemGrid,
  LotGrade,
  Point,
} from "@/packages/schema/building-model";
import { fromLocal } from "./geo";
import { buildHouse } from "./layout";
import { ringCentroid, sampleDemHeight } from "./compound-geom";
import type { ScanResult } from "./sources";

function shiftPt(p: Point, dx: number, dy: number): Point {
  return [p[0] - dx, p[1] - dy];
}

function shiftRing(ring: Point[], dx: number, dy: number): Point[] {
  return ring.map((p) => shiftPt(p, dx, dy));
}

function parseOsmId(modelId: string): number | null {
  const m = /^osm-(\d+)$/.exec(modelId);
  return m ? Number(m[1]) : null;
}

function eaveHeight(model: BuildingModel): number {
  const above = model.floors.filter((f) => f.level >= 0);
  if (!above.length) return Math.max(3.5, model.floors.length * 2.75);
  const top = above.reduce((a, b) => (a.level >= b.level ? a : b));
  return Math.max(3.5, top.elevation + top.height);
}

function storiesFromShellHeight(h: number): number {
  return Math.max(1, Math.min(12, Math.round(h / 2.75)));
}

function shiftDem(dem: DemGrid, dx: number, dy: number, zBias: number): DemGrid {
  return {
    ...dem,
    x0: dem.x0 - dx,
    y0: dem.y0 - dy,
    z: dem.z.map((z) => z - zBias),
  };
}

function shiftGrade(grade: LotGrade | undefined, dx: number, dy: number, zBias: number): LotGrade | undefined {
  if (!grade) return undefined;
  return {
    ...grade,
    origin: shiftPt(grade.origin, dx, dy),
    dem: grade.dem ? shiftDem(grade.dem, dx, dy, zBias) : undefined,
  };
}

/** Find the ghost shell for an OSM way id (`neighbor-{id}`). */
export function findNeighborFeature(model: BuildingModel, wayId: number): CompoundFeature | null {
  const features = model.compound?.features ?? [];
  return features.find((f) => f.kind === "neighbor" && f.id === `neighbor-${wayId}`) ?? null;
}

/**
 * Rebuild the focus house + compound so `wayId` is at the origin.
 * Surroundings (roads, DEM, other shells) are translated — not regenerated.
 */
export function reframeModelToNeighbor(model: BuildingModel, wayId: number): BuildingModel {
  const compound = model.compound;
  if (!compound?.features?.length) {
    throw new Error("This scan has no surrounding site to reframe.");
  }
  const target = findNeighborFeature(model, wayId);
  if (!target || target.polygon.length < 3) {
    throw new Error("That nearby house is not in the loaded site.");
  }

  const [dx, dy] = ringCentroid(target.polygon);
  const zBias =
    compound.grade?.dem != null ? (sampleDemHeight([dx, dy], compound.grade.dem) ?? 0) : 0;

  const oldOsmId = parseOsmId(model.id);
  const oldEave = eaveHeight(model);
  const oldLabel = model.address?.trim() || "Previous house";
  const oldFootprint = model.footprint.length >= 3 ? model.footprint : null;

  const shiftedFeatures: CompoundFeature[] = [];
  for (const f of compound.features) {
    if (f.id === target.id) continue; // becomes the focus house
    shiftedFeatures.push({
      ...f,
      polygon: shiftRing(f.polygon, dx, dy),
    });
  }

  // Prior focus becomes a ghost neighbor shell.
  if (oldFootprint) {
    const nbrId = oldOsmId != null ? `neighbor-${oldOsmId}` : `neighbor-prev-${model.id}`;
    if (!shiftedFeatures.some((f) => f.id === nbrId)) {
      shiftedFeatures.push({
        id: nbrId,
        kind: "neighbor",
        label: oldLabel,
        polygon: shiftRing(oldFootprint, dx, dy),
        height: oldEave,
        source: "map",
      });
    }
  }

  const newFootprint = shiftRing(target.polygon, dx, dy);
  const geo = fromLocal({ lat: model.lat, lng: model.lng }, [dx, dy]);
  const address =
    target.label && !/^neighbor$/i.test(target.label.trim()) ? target.label : model.address;
  const stories = storiesFromShellHeight(target.height || oldEave);
  const streetDir =
    compound.grade?.downhill != null
      ? ([compound.grade.downhill[0], compound.grade.downhill[1]] as Point)
      : null;

  const { model: built, notes } = buildHouse({
    id: `osm-${wayId}`,
    source: model.source,
    confidence: Math.min(model.confidence, 0.72),
    address,
    lat: geo.lat,
    lng: geo.lng,
    footprint: newFootprint,
    streetDir,
    stories,
    basement: false,
    garage: "none",
    roof: model.roof?.shape ?? "gable",
  });

  const grade = shiftGrade(compound.grade, dx, dy, zBias);
  built.compound = {
    features: shiftedFeatures,
    basis: compound.basis ?? "compound-v55",
    grade: grade
      ? { ...grade, origin: ringCentroid(newFootprint) }
      : undefined,
  };
  built.markers = (model.markers ?? []).map((m) => ({
    ...m,
    pos: shiftPt(m.pos, dx, dy),
  }));
  built.interior = {
    status: "estimated",
    source: "typical layout after neighbor reframe (site reused)",
    reasons: [],
    knownLevels: [],
    notes: [
      "Rooms follow a typical plan inside this footprint. Surroundings were reused from the previous scan.",
      ...notes,
    ],
  };

  return built;
}

/** Update a saved scan result after reframing to a neighbor. */
export function reframeScanToNeighbor(result: ScanResult, wayId: number): ScanResult {
  const model = reframeModelToNeighbor(result.model, wayId);
  const fp = model.footprint;
  let width = result.summary.width;
  let depth = result.summary.depth;
  let area = result.summary.area;
  if (fp.length >= 3) {
    const xs = fp.map((p) => p[0]);
    const ys = fp.map((p) => p[1]);
    width = Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10;
    depth = Math.round((Math.max(...ys) - Math.min(...ys)) * 10) / 10;
    area = Math.round(Math.abs(fp.reduce((s, p, i) => {
      const q = fp[(i + 1) % fp.length]!;
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2));
  }
  return {
    ...result,
    model,
    warnings: [
      ...result.warnings.filter((w) => !/neighbor reframe/i.test(w)),
      "Switched to a nearby house — surroundings reused; interior is estimated from the footprint.",
    ],
    summary: {
      ...result.summary,
      width,
      depth,
      area,
      stories: model.floors.filter((f) => f.level >= 0).length,
      match: "nearest",
    },
    createdAt: new Date().toISOString(),
  };
}
