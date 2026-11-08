/** Building program tags / story caps — no schema imports (node:test friendly). */

export type BuildingUse =
  | "house"
  | "school"
  | "university"
  | "library"
  | "office"
  | "church"
  | "commercial"
  | "dormitory"
  | "apartments"
  | "hotel"
  | "hospital"
  | "warehouse";

export function buildingUseFromTag(tag: string | undefined | null): BuildingUse {
  const t = (tag ?? "").toLowerCase().trim();
  if (!t || t === "yes" || t === "house" || t === "detached" || t === "semidetached_house" || t === "terrace" || t === "bungalow" || t === "static_caravan" || t === "residential") {
    return "house";
  }
  if (t === "dormitory" || t === "hall_of_residence") return "dormitory";
  if (t === "apartments") return "apartments";
  if (t === "hotel" || t === "motel" || t === "hostel") return "hotel";
  if (t === "hospital" || t === "clinic") return "hospital";
  if (t === "warehouse" || t === "industrial" || t === "manufacture" || t === "factory") return "warehouse";
  if (t === "university" || t === "college" || t === "college_building" || t === "university_building") return "university";
  if (t === "library") return "library";
  if (t === "school" || t === "kindergarten") return "school";
  if (t === "church" || t === "cathedral" || t === "chapel" || t === "mosque" || t === "synagogue" || t === "temple" || t === "place_of_worship") {
    return "church";
  }
  if (t === "office") return "office";
  if (t === "commercial" || t === "retail" || t === "supermarket" || t === "public") return "commercial";
  return "house";
}

/** Prefer amenity when it names a program more clearly than building=yes / residential. */
export function buildingUseFromTags(tags: Record<string, string> | undefined | null): BuildingUse {
  const amenity = (tags?.amenity ?? "").toLowerCase().trim();
  if (amenity === "hospital" || amenity === "clinic" || amenity === "doctors") return "hospital";
  if (amenity === "university" || amenity === "college") return "university";
  if (amenity === "library") return "library";
  if (amenity === "school" || amenity === "kindergarten") return "school";
  if (amenity === "place_of_worship") return "church";
  if (amenity === "hotel" || amenity === "motel" || amenity === "hostel") return "hotel";
  if (amenity === "dormitory") return "dormitory";
  return buildingUseFromTag(tags?.building);
}

/** True when OSM only gave a generic residential / yes tag (assessor cues may refine it). */
export function isGenericResidentialUse(tags: Record<string, string> | undefined | null): boolean {
  const amenity = (tags?.amenity ?? "").toLowerCase().trim();
  if (amenity) return false;
  const t = (tags?.building ?? "").toLowerCase().trim();
  return !t || t === "yes" || t === "residential" || t === "house" || t === "detached" || t === "semidetached_house" || t === "terrace" || t === "bungalow";
}

/** Max modeled floors by building program — keeps houses compact, public / multi-unit taller. */
export function maxStoriesForUse(use: BuildingUse | undefined | null): number {
  if (use === "church") return 1;
  if (use === "warehouse") return 3;
  if (
    use === "school" ||
    use === "university" ||
    use === "library" ||
    use === "office" ||
    use === "commercial" ||
    use === "dormitory" ||
    use === "apartments" ||
    use === "hotel" ||
    use === "hospital"
  ) {
    return 6;
  }
  return 3;
}

/** Short label for scan attributes / interior notes. */
export function planWordForUse(use: BuildingUse): string {
  switch (use) {
    case "school":
      return "school";
    case "university":
      return "university";
    case "library":
      return "library";
    case "office":
      return "office";
    case "commercial":
      return "commercial";
    case "church":
      return "worship";
    case "dormitory":
      return "dormitory";
    case "apartments":
      return "apartment";
    case "hotel":
      return "hotel";
    case "hospital":
      return "hospital";
    case "warehouse":
      return "warehouse";
    default:
      return "house";
  }
}
