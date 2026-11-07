/**
 * The scan pipeline: address or photo location -> building outline -> imagery -> photo reading -> 3D model.
 * Every step reports what it used, so the UI can show exactly where each fact came from.
 */
import { fromLocal, polygonArea, polygonCentroid, type LatLng } from "./geo";
import { geocode, nominatimBuildingId } from "./geocode";
import { lookupBuilding, type OsmContext } from "./overpass";
import { pinnedWayId } from "./pins";
import { verifiedInterior } from "./interiors";
import { aerialImage, type Image } from "./imagery";
import { describeHouse, geminiAvailable, geminiModel, type HouseFacts } from "./vision";
import { buildHouse, type GarageSide } from "./layout";
import { store } from "./store";
import type { AttributeReport, ScanEvent, ScanResult, SourceReport, StepKey } from "./sources";
import type { Point, RoofShape } from "@/packages/schema/building-model";

export type ScanInput = {
  address?: string;
  lat?: number;
  lng?: number;
  heading?: number | null;
  photo?: Image | null;
  rescan?: boolean;
  /** OSM way to use when the user says we drew the house next door. */
  wayId?: number;
};

/** An error whose message is safe and useful to show the user. */
export class ScanError extends Error {}

const OSM_ROOF: Record<string, RoofShape> = {
  gabled: "gable", "half-hipped": "hip", hipped: "hip", pyramidal: "hip", flat: "flat", skillion: "flat",
  gambrel: "gambrel", mansard: "mansard", saltbox: "gable", dome: "other", round: "other",
};
/** Residential height includes the roof, so a 9 m "height" is usually two floors, not three. */
function storiesFromHeight(meters: number): number {
  if (meters < 4.5) return 1;
  if (meters < 11) return 2;
  if (meters < 14) return 3;
  return Math.min(5, Math.round(meters / 3.2));
}

const NOT_A_HOUSE = new Set([
  "apartments", "commercial", "retail", "industrial", "office", "school", "church", "university",
  "hospital", "warehouse", "hotel", "civic", "public", "dormitory",
]);

export async function runScan(input: ScanInput, emit: (e: ScanEvent) => void): Promise<void> {
  const sources: SourceReport[] = [];
  const attributes: AttributeReport[] = [];
  const warnings: string[] = [];
  const step = (key: StepKey, status: "active" | "done" | "skipped", detail?: string) =>
    emit({ type: "step", key, status, detail });

  // 1. Where is the house?
  step("locate", "active");
  let origin: LatLng;
  let geocodedWay: number | null = null;
  let address = input.address?.trim() ?? "";
  if (address) {
    const g = await geocode(address, sources);
    if (!g) throw new ScanError("We couldn't find that address. Check the spelling and include the city and state.");
    origin = g;
    geocodedWay = g.wayId ?? null;
    address = g.matched;
    step("locate", "done", g.matched);
  } else if (input.lat != null && input.lng != null) {
    origin = { lat: input.lat, lng: input.lng };
    sources.push({
      id: "gps", name: "Photo / device location", status: "used",
      detail: `${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}` +
        (input.heading != null ? `, camera facing ${Math.round(input.heading)}°` : ""),
    });
    step("locate", "done", `${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}`);
  } else {
    throw new ScanError("We need an address or a photo with a location to find the house.");
  }

  // 2. Real building outline from OpenStreetMap.
  step("outline", "active");
  let osm: OsmContext | null = null;
  try {
    const wayId = input.wayId ?? pinnedWayId(address) ?? geocodedWay ?? (address ? await nominatimBuildingId(input.address ?? address) : null);
    osm = await lookupBuilding(origin, input.heading, { address, wayId, force: input.wayId != null });
  } catch (e) {
    sources.push({ id: "osm", name: "OpenStreetMap buildings", status: "failed", detail: `Map server didn't respond (${String(e)}).` });
  }
  const b = osm?.building ?? null;
  let center = origin;
  let footprint: Point[] | null = null;
  let id: string;
  if (b) {
    const c = polygonCentroid(b.ring);
    center = fromLocal(origin, c);
    footprint = b.ring.map(([x, y]) => [x - c[0], y - c[1]] as Point);
    id = `osm-${b.id}`;
    const how = {
      "address-tag": "its mapped house number and street match your address",
      "geocoder-building": "the map's address search points to it",
      "contains-point": "the address point is inside it",
      "in-view-direction": "it's the closest building in the direction the camera faced",
      nearest: "it's the closest building to the address point",
      none: "",
    }[osm!.chosenBy];
    sources.push({
      id: "osm", name: "OpenStreetMap buildings", status: "used",
      detail: `Building outline #${b.id} (${Math.round(b.area)} m²), picked because ${how}. ${osm!.buildingCount} buildings nearby.`,
    });
    step("outline", "done", `${Math.round(b.area)} m² outline`);
    if (input.address && osm!.chosenBy === "nearest") {
      warnings.push("We couldn't match this address to a specific mapped building, so we used the closest one. It may be a neighbor. Check it against the aerial photo.");
    }
    if (NOT_A_HOUSE.has(b.tags.building)) {
      warnings.push(`OpenStreetMap lists this as "${b.tags.building}", not a house. The room layout assumes a home.`);
    }
    if (!address && b.tags["addr:street"]) {
      address = [b.tags["addr:housenumber"], b.tags["addr:street"], b.tags["addr:city"]].filter(Boolean).join(" ");
    }
  } else {
    id = `pt-${origin.lat.toFixed(5)}_${origin.lng.toFixed(5)}`;
    if (osm) {
      sources.push({ id: "osm", name: "OpenStreetMap buildings", status: "failed", detail: "No building outline is mapped at this spot." });
    }
    warnings.push(
      osm
        ? "No building outline is mapped here, so a typical 11 × 9 m house was used. Size and shape are estimates."
        : "The map server didn't respond, so a typical 11 × 9 m house was used. Try Re-scan in a minute.",
    );
    step("outline", "skipped", osm ? "No outline mapped, using a typical size" : "Map unavailable, using a typical size");
  }

  // Saved scan? Then we're done, no imagery or AI calls needed.
  if (!input.rescan) {
    const saved = await store.get(id);
    // Empty shells from before interiors were drawn again should be rebuilt.
    if (saved && saved.model.interior?.status !== "unknown") {
      for (const k of ["imagery", "vision", "build"] as StepKey[]) step(k, "done", "Saved scan");
      emit({ type: "result", result: saved, cached: true });
      return;
    }
  }

  // 3. Aerial imagery.
  step("imagery", "active");
  let aerial: Image | null = null;
  const extent = footprint ? Math.max(...footprint.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) : 8;
  try {
    // Esri refuses to render below ~35 m half-width (beyond its max zoom), so never ask for less than 40.
    aerial = await aerialImage(center, Math.min(80, Math.max(40, extent * 2.5)));
    sources.push({ id: "esri", name: "Esri World Imagery", status: "used", detail: "Aerial photo centered on the building." });
    step("imagery", "done");
  } catch (e) {
    sources.push({ id: "esri", name: "Esri World Imagery", status: "failed", detail: String(e) });
    step("imagery", "skipped", "Imagery unavailable");
  }

  const tags = b?.tags ?? {};
  const mapFacts = [
    b ? `Outline area: ${Math.round(b.area)} m²` : "No mapped outline",
    tags.building ? `Building type: ${tags.building}` : null,
    tags["building:levels"] ? `Levels: ${tags["building:levels"]}` : null,
    tags["roof:shape"] ? `Roof shape: ${tags["roof:shape"]}` : null,
    tags.height ? `Height: ${tags.height} m` : null,
    tags["building:material"] ? `Material: ${tags["building:material"]}` : null,
  ].filter(Boolean).join("\n");

  // 4. Read the house from the photos (Gemini).
  step("vision", "active");
  let facts: HouseFacts | null = null;
  if (!geminiAvailable()) {
    sources.push({
      id: "gemini", name: "Google Gemini (photo reading)", status: "skipped",
      detail: "No GEMINI_API_KEY configured, so floors, roof and garage come from map data or typical values.",
    });
    step("vision", "skipped", "Not configured");
  } else if (!input.photo && !aerial) {
    sources.push({ id: "gemini", name: "Google Gemini (photo reading)", status: "skipped", detail: "No images to read." });
    step("vision", "skipped", "No images");
  } else {
    try {
      facts = await describeHouse({ photo: input.photo ?? null, aerial, facts: mapFacts });
      sources.push({
        id: "gemini", name: `Google Gemini (${geminiModel()})`, status: "used",
        detail: `Read ${[input.photo && "your photo", aerial && "the aerial photo"].filter(Boolean).join(" and ")}. ` +
          `Looks like a ${facts.stories}-story ${facts.style} with ${facts.exterior_material}.`,
      });
      if (facts.photo_matches_aerial === "no") {
        warnings.push("Your photo doesn't seem to match the building at this location. Double-check the address.");
      }
      step("vision", "done", `${facts.stories}-story ${facts.style}`);
    } catch (e) {
      sources.push({ id: "gemini", name: "Google Gemini (photo reading)", status: "failed", detail: String(e).slice(0, 200) });
      step("vision", "skipped", "Photo reading failed");
    }
  }
  const sure = facts && facts.confidence >= 0.35 ? facts : null;

  // Merge: map data and photos first, typical values last. Record where each value came from.
  let stories = 2;
  const osmLevels = parseInt(tags["building:levels"] ?? "", 10);
  const osmHeight = parseFloat(tags.height ?? "");
  if (input.photo && sure) {
    stories = sure.stories;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "photos" });
  } else if (osmLevels >= 1 && osmLevels <= 5) {
    stories = osmLevels;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "map", note: "OpenStreetMap building:levels" });
  } else if (osmHeight > 2) {
    stories = storiesFromHeight(osmHeight);
    attributes.push({ field: "Floors above ground", value: String(stories), from: "map", note: `From mapped height ${osmHeight} m` });
  } else if (sure) {
    stories = sure.stories;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "photos" });
  } else {
    attributes.push({ field: "Floors above ground", value: "2", from: "estimated", note: "Most common for houses in the area" });
  }
  if (stories > 3) {
    warnings.push(`This building has ${stories} floors; the model shows the first 3.`);
    attributes[attributes.length - 1].value = `${stories} (showing 3)`;
    stories = 3;
  }

  let roof: RoofShape = "gable";
  const area = footprint ? polygonArea(footprint) : 99;
  if (tags["roof:shape"] && OSM_ROOF[tags["roof:shape"]]) {
    roof = OSM_ROOF[tags["roof:shape"]];
    attributes.push({ field: "Roof", value: roof, from: "map", note: `OpenStreetMap roof:shape=${tags["roof:shape"]}` });
  } else if (sure) {
    roof = sure.roof_shape;
    attributes.push({ field: "Roof", value: roof, from: "photos" });
  } else {
    roof = area > 350 ? "flat" : "gable";
    attributes.push({ field: "Roof", value: roof, from: "estimated", note: area > 350 ? "Large footprint" : "Most common roof type" });
  }

  let garage: GarageSide = "none";
  if (sure && (sure.garage === "attached_left" || sure.garage === "attached_right")) {
    garage = sure.garage === "attached_left" ? "left" : "right";
    attributes.push({ field: "Garage", value: `Attached, ${garage} side`, from: "photos" });
  } else if (sure && sure.garage === "detached") {
    attributes.push({ field: "Garage", value: "Detached (not modeled)", from: "photos" });
  } else if (sure && sure.garage === "none") {
    attributes.push({ field: "Garage", value: "None", from: "photos" });
  } else {
    attributes.push({ field: "Garage", value: "None shown", from: "estimated", note: "Couldn't tell from the data" });
  }

  let basement = center.lat > 37;
  if (sure && (sure.basement === "visible" || sure.basement === "likely")) {
    basement = true;
    attributes.push({ field: "Basement", value: "Yes", from: "photos", note: sure.basement === "visible" ? "Visible in photo" : "Likely from the photos" });
  } else if (sure && sure.basement === "unlikely") {
    basement = false;
    attributes.push({ field: "Basement", value: "No", from: "photos" });
  } else {
    attributes.push({
      field: "Basement", value: basement ? "Yes" : "No", from: "estimated",
      note: basement ? "Most houses this far north have one" : "Uncommon in this region",
    });
  }

  // 5. Build the 3D model.
  step("build", "active");
  const streetDir = osm?.roadDir ?? null;
  let confidence = 0.2;
  if (footprint) confidence += 0.3;
  if (streetDir) confidence += 0.1;
  if (attributes.find((a) => a.field === "Floors above ground")?.from !== "estimated") confidence += 0.1;
  if (attributes.find((a) => a.field === "Roof")?.from !== "estimated") confidence += 0.05;
  if (facts) confidence += 0.15 * facts.confidence;
  confidence = Math.min(0.9, confidence);

  const verified = verifiedInterior(id);
  const built = buildHouse({
    id,
    source: input.address ? "address" : "photo",
    confidence: Math.round(confidence * 100) / 100,
    address,
    lat: center.lat,
    lng: center.lng,
    footprint,
    streetDir,
    stories,
    basement,
    garage,
    roof,
  });

  if (verified) {
    built.model = { ...verified, address: verified.address || address, markers: [] };
  } else if (input.wayId && b) {
    const tagged = [b.tags["addr:housenumber"], b.tags["addr:street"]].filter(Boolean).join(" ");
    if (tagged) {
      address = tagged;
      built.model.address = tagged;
    }
  }
  if (!verified) {
    built.model.interior = {
      status: "estimated",
      source: "typical layout inside the mapped outline",
      reasons: [],
      knownLevels: [],
      notes: ["Rooms follow a common house plan. They are not a measured scan of this house."],
    };
    warnings.push(...built.notes);
  } else {
    warnings.push(...built.notes);
  }

  attributes.unshift(
    {
      field: "Footprint", value: `${built.width.toFixed(1)} × ${built.depth.toFixed(1)} m`,
      from: footprint ? "map" : "estimated", note: footprint ? "Real outline from OpenStreetMap" : "Typical house size",
    },
    {
      field: "Front faces", value: built.facing,
      from: streetDir ? "map" : "estimated",
      note: streetDir ? `Toward ${osm?.roadName ?? "the nearest street"}` : "No street found nearby",
    },
  );
  if (facts) {
    attributes.push(
      { field: "Exterior", value: facts.exterior_material, from: "photos" },
      { field: "Style", value: facts.style, from: "photos" },
    );
  }
  attributes.push(
    verified
      ? { field: "Interior", value: "Verified", from: "map", note: `Source: ${verified.interior?.source}` }
      : { field: "Interior", value: "Typical layout", from: "estimated", note: "A common room plan inside the real outline. Not a measured scan." },
  );
  sources.push(
    verified
      ? { id: "layout", name: "Verified interior", status: "used", detail: `Real room layout from: ${verified.interior?.source}.` }
      : {
          id: "layout", name: "Interior layout", status: "used",
          detail: "Typical room plan drawn inside the mapped outline. Not a measured scan.",
        },
  );
  step("build", "done");

  const result: ScanResult = {
    model: built.model,
    sources,
    attributes,
    warnings,
    images: aerial ? [{ label: "Aerial view · Esri World Imagery", url: `data:${aerial.mime};base64,${aerial.base64}` }] : [],
    summary: {
      width: built.width, depth: built.depth, area: Math.round(area), facing: built.facing, stories, streetDir,
      nearby: osm?.nearby ?? [],
      match: osm?.chosenBy === "nearest" || osm?.chosenBy === "in-view-direction" ? "nearest" : osm?.chosenBy === "contains-point" ? "point" : "address",
    },
    createdAt: new Date().toISOString(),
  };
  // Don't save scans where the map server was down; the next try should get the real outline.
  if (osm) await store.put(result);
  emit({ type: "result", result, cached: false });
}
