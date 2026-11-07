import { BuildingModel, type BuildingModel as Building } from "@/packages/schema/building-model";
import {
  applyExploration,
  measureModel,
  type ExplorationInput,
  type HouseDimensions,
  type HouseRecord,
} from "@/lib/explored-house";
import { getDb } from "@/lib/mongo";

export type SavedBuilding = {
  id: string;
  revision: number;
  updatedAt: string;
  dimensions: HouseDimensions;
  model: Building;
};

function asRecord(doc: Record<string, unknown> | null): HouseRecord | null {
  if (!doc) return null;
  const model = BuildingModel.parse(doc);
  return {
    ...model,
    rawTrail: Array.isArray(doc.rawTrail) ? (doc.rawTrail as HouseRecord["rawTrail"]) : [],
    rawHazards: Array.isArray(doc.rawHazards) ? (doc.rawHazards as HouseRecord["rawHazards"]) : [],
    revision: typeof doc.revision === "number" ? doc.revision : 0,
  };
}

function savedFrom(model: Building, revision: number, updatedAt: string, dimensions: HouseDimensions): SavedBuilding {
  return { id: model.id, revision, updatedAt, dimensions, model };
}

export async function getBuilding(id: string): Promise<SavedBuilding | null> {
  const db = await getDb();
  const doc = await db.collection("buildings").findOne({ id });
  if (!doc) return null;
  const model = BuildingModel.parse(doc);
  const dimensions =
    (doc.dimensions as HouseDimensions | undefined) ??
    measureModel(model);
  return savedFrom(model, typeof doc.revision === "number" ? doc.revision : 1, String(doc.updatedAt ?? ""), dimensions);
}

export async function listBuildings() {
  const db = await getDb();
  const docs = await db
    .collection("buildings")
    .find({ source: "wifi" }, { projection: { id: 1, address: 1, source: 1, revision: 1, updatedAt: 1, confidence: 1, dimensions: 1 } })
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();
  return docs.map((doc) => ({
    id: doc.id,
    address: doc.address,
    source: doc.source,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    confidence: doc.confidence,
    dimensions: doc.dimensions,
  }));
}

export async function upsertBuilding(model: Building): Promise<SavedBuilding> {
  const db = await getDb();
  const buildings = db.collection("buildings");
  const existing = await buildings.findOne({ id: model.id });
  const revision = (typeof existing?.revision === "number" ? existing.revision : 0) + 1;
  const previous = existing?.dimensions as HouseDimensions | undefined;
  const dimensions = measureModel(
    model,
    previous?.exploredWidthM != null && previous.exploredDepthM != null
      ? { exploredWidthM: previous.exploredWidthM, exploredDepthM: previous.exploredDepthM }
      : null,
  );
  const updatedAt = new Date().toISOString();
  await buildings.replaceOne(
    { id: model.id },
    {
      ...model,
      revision,
      updatedAt,
      dimensions,
      rawTrail: existing?.rawTrail ?? [],
      rawHazards: existing?.rawHazards ?? [],
      location: { type: "Point", coordinates: [model.lng, model.lat] },
    },
    { upsert: true },
  );
  return savedFrom(model, revision, updatedAt, dimensions);
}

export async function recordExploration(input: ExplorationInput): Promise<SavedBuilding & { placedOnPlan: boolean }> {
  const db = await getDb();
  const buildings = db.collection("buildings");
  const existingDoc = await buildings.findOne({ id: input.buildingId });
  const applied = applyExploration(asRecord(existingDoc as Record<string, unknown> | null), input);
  const model = BuildingModel.parse(applied.model);
  const dimensions = measureModel(model, {
    exploredWidthM: applied.exploredWidthM,
    exploredDepthM: applied.exploredDepthM,
  });
  const updatedAt = new Date().toISOString();

  await buildings.replaceOne(
    { id: model.id },
    {
      ...model,
      revision: applied.revision,
      updatedAt,
      dimensions,
      rawTrail: applied.rawTrail,
      rawHazards: applied.rawHazards,
      lastDeviceId: input.deviceId,
      location: { type: "Point", coordinates: [model.lng, model.lat] },
    },
    { upsert: true },
  );

  await db.collection("explorations").insertOne({
    buildingId: model.id,
    deviceId: input.deviceId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    placedOnPlan: applied.placedOnPlan,
    breadcrumbs: input.breadcrumbs,
    hazards: input.hazards,
    exploredWidthM: dimensions.exploredWidthM,
    exploredDepthM: dimensions.exploredDepthM,
    createdAt: updatedAt,
  });

  return { ...savedFrom(model, applied.revision, updatedAt, dimensions), placedOnPlan: applied.placedOnPlan };
}
