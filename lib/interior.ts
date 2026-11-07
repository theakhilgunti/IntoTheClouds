/** Pure helpers (safe in the browser and on the server) for tracking which floors have a real interior. */
import type { BuildingModel, Floor } from "@/packages/schema/building-model";

/** Work out the interior status from the floors: verified only when EVERY floor has real rooms. */
export function summarizeInterior(
  floors: Floor[],
  prev: BuildingModel["interior"],
  extraNotes: string[] = [],
): NonNullable<BuildingModel["interior"]> {
  const knownLevels = floors.filter((f) => f.rooms.length > 0).map((f) => f.level);
  const missing = floors.filter((f) => f.rooms.length === 0).map((f) => f.name);
  const roomCount = floors.reduce((s, f) => s + f.rooms.length, 0);
  const notes = [...new Set([...(prev?.notes ?? []), ...extraNotes])];
  if (!missing.length) {
    return { status: "verified", source: `uploaded floor plan, read by AI (${roomCount} rooms)`, knownLevels, notes, reasons: [] };
  }
  const kept = (prev?.reasons ?? []).filter((r) => !r.startsWith("No floor plan") && !r.startsWith("Floor plan not provided"));
  return {
    status: "unknown",
    source: knownLevels.length ? "uploaded floor plan, read by AI" : undefined,
    knownLevels,
    notes,
    reasons: knownLevels.length
      ? [`Floor plan not provided for: ${missing.join(", ")}.`, ...kept]
      : prev?.reasons ?? [],
  };
}

/** After a Re-scan, keep the floors that came from a real plan instead of replacing them with the empty shell. */
export function mergeKnownFloors(fresh: BuildingModel, old: BuildingModel): BuildingModel {
  const known = old.interior?.knownLevels ?? [];
  if (old.id !== fresh.id || !known.length) return fresh;
  const kept = old.floors.filter((f) => known.includes(f.level) && f.rooms.length > 0);
  const floors = [...fresh.floors.filter((f) => !kept.some((k) => k.level === f.level)), ...kept].sort((a, b) => a.level - b.level);
  return { ...fresh, floors, interior: summarizeInterior(floors, { ...fresh.interior!, notes: old.interior?.notes ?? [] }) };
}
