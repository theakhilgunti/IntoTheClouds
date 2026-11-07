import { BuildingModel } from "@/packages/schema/building-model";
import INTERIORS from "@/data/interiors";

/** A real, verified layout for this building id, or null when nothing measured its interior. */
export function verifiedInterior(id: string): BuildingModel | null {
  const raw = INTERIORS[id];
  if (!raw) return null;
  const parsed = BuildingModel.safeParse(raw);
  if (!parsed.success || parsed.data.interior?.status !== "verified" || !parsed.data.interior.source) {
    console.error(`Interior for ${id} is invalid or not marked verified with a source; ignoring it.`);
    return null;
  }
  return parsed.data;
}
