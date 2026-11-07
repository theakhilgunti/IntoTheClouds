/**
 * The scan pipeline: address or photo location -> building outline -> imagery -> photo reading -> 3D model.
 * Every step reports what it used, so the UI can show exactly where each fact came from.
 */
import { fromLocal, pointInPolygon, polygonArea, polygonCentroid, toLocal, type LatLng } from "./geo";
import { geocode, nominatimBuildingId } from "./geocode";
import { lookupBuilding, type OsmContext } from "./overpass";
import { pinnedWayId } from "./pins";
import { verifiedInterior } from "./interiors";
import { aerialImage, type Image } from "./imagery";
import { describeHouse, describeSite, geminiAvailable, geminiModel, type HouseFacts } from "./vision";
import { accessFeatures, assembleCompound, boxToPolygon, compoundReach, pickGarage } from "./compound-geom";
import { inNyc, lookupParcel, type ParcelHit } from "./parcel";
import { buildHouse, type GarageSide } from "./layout";
import { analyzeAerialRoof } from "./aerial-roof";
import { inferRoofPlan } from "./roof-infer";
import { store } from "./store";
import type { AttributeReport, ScanEvent, ScanResult, SourceReport, StepKey } from "./sources";
import type { Point, RoofPlan, RoofShape } from "@/packages/schema/building-model";

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

/** 2.5 in the tax roll is two full floors plus a half story, so it counts as 2. */
function storiesFromPluto(n: number): number | null {
  if (!Number.isFinite(n) || n < 1 || n > 8) return null;
  return Math.max(1, Math.round(n - 0.01));
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
    // Empty shells, and address scans from before the lot was drawn, get rebuilt.
    const stale = !!saved && (saved.model.source === "address" || saved.model.source === "photo") && saved.model.compound?.basis !== "compound-v2";
    if (saved && saved.model.interior?.status !== "unknown" && !stale) {
      for (const k of ["imagery", "vision", "build"] as StepKey[]) step(k, "done", "Saved scan");
      emit({ type: "result", result: saved, cached: true });
      return;
    }
  }

  // City lot, when this address is in New York City. The yard follows the lot the building actually sits on.
  let lot: ParcelHit | null = null;
  let buildingOnLot = false;
  if (inNyc(center)) {
    try {
      const byAddress = address ? await lookupParcel(origin, address) : null;
      const addressRing = byAddress ? byAddress.ring.map((p) => toLocal(origin, p)) : null;
      const atBuilding = b ? polygonCentroid(b.ring) : null;
      const addressHoldsBuilding = !!(atBuilding && addressRing && pointInPolygon(atBuilding, addressRing));
      if (b && !addressHoldsBuilding) {
        const under = await lookupParcel(center);
        lot = under ?? byAddress;
        if (under && byAddress && under.address && byAddress.address && under.address !== byAddress.address) {
          warnings.push(
            `The mapped building sits on the city lot for ${under.address}, not ${byAddress.address}. The yard follows the lot the building is on.`,
          );
        }
      } else {
        lot = byAddress;
      }
      if (lot && atBuilding) buildingOnLot = pointInPolygon(atBuilding, lot.ring.map((p) => toLocal(origin, p)));
      sources.push({
        id: "parcel",
        name: "NYC tax lot",
        status: lot ? "used" : "failed",
        detail: lot
          ? `${lot.address || "Lot"}${lot.numBuildings != null ? `, ${lot.numBuildings} building${lot.numBuildings === 1 ? "" : "s"} on the lot` : ""}.`
          : "No tax lot matched this address.",
      });
    } catch (e) {
      sources.push({ id: "parcel", name: "NYC tax lot", status: "failed", detail: String(e).slice(0, 160) });
    }
  }

  // 3. Aerial imagery.
  step("imagery", "active");
  let aerial: Image | null = null;
  let aerialHalf = 40;
  const extent = footprint ? Math.max(...footprint.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) : 8;
  try {
    // Wide enough to cover the lot around large footprints; Esri needs ≥ ~40 m half-width.
    const wantHalf = Math.min(180, Math.max(40, extent * 3.5, footprint ? compoundReach(footprint) * 0.85 : 40));
    const shot = await aerialImage(center, wantHalf);
    aerial = shot.image;
    aerialHalf = shot.halfSize;
    sources.push({
      id: "esri",
      name: "Esri World Imagery",
      status: "used",
      detail: `Aerial photo (~${Math.round(aerialHalf)} m half-width) centered on the building.`,
    });
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

  // 4. Read the house from the photos (Gemini). The site boxes run alongside that, and a missing key just skips both.
  step("vision", "active");
  let facts: HouseFacts | null = null;
  const sitePromise = geminiAvailable() && aerial
    ? describeSite(aerial).catch((e) => {
        console.warn("aerial site read failed", e);
        return [];
      })
    : Promise.resolve([]);
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
  const siteBoxes = await sitePromise;
  const sure = facts && facts.confidence >= 0.35 ? facts : null;
  const plutoStories = buildingOnLot && lot?.numFloors != null ? storiesFromPluto(lot.numFloors) : null;

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
  } else if (plutoStories) {
    stories = plutoStories;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "map", note: `NYC tax lot lists ${lot!.numFloors}` });
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

  const aerialCue = aerial ? analyzeAerialRoof(aerial) : null;
  const inferred = footprint
    ? inferRoofPlan({
        footprint,
        osmTags: tags,
        aerial: aerialCue,
        gemini: sure
          ? { roof_shape: sure.roof_shape, ridge_along: sure.ridge_along ?? "unknown" }
          : null,
      })
    : null;
  const roof: RoofShape = inferred?.shape ?? "gable";
  const ridgeAlong: "width" | "depth" | undefined = inferred?.ridgeAlong;
  const roofPlan: RoofPlan | null = inferred
    ? {
        kind: inferred.kind,
        source: inferred.source,
        wings: inferred.wings.map((w, i) => ({
          polygon: w.polygon.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as Point),
          ridge: w.ridge
            ? [
                [Math.round(w.ridge[0][0] * 1e4) / 1e4, Math.round(w.ridge[0][1] * 1e4) / 1e4] as Point,
                [Math.round(w.ridge[1][0] * 1e4) / 1e4, Math.round(w.ridge[1][1] * 1e4) / 1e4] as Point,
              ]
            : undefined,
          height: w.height,
          shape: w.shape,
        })),
      }
    : null;
  // Keep OSM enum map for attribute wording when the tag is present.
  const osmRoof = tags["roof:shape"] || tags["building:roof:shape"];
  const roofFrom =
    inferred?.source === "map" ? "map" : inferred?.source === "photos" ? "photos" : inferred?.source === "aerial" ? "photos" : "estimated";
  attributes.push({
    field: "Roof",
    value: roof,
    from: roofFrom,
    note:
      osmRoof && OSM_ROOF[osmRoof]
        ? `OpenStreetMap roof:shape=${osmRoof}`
        : aerialCue?.note
          ? aerialCue.note
          : inferred?.source === "footprint"
            ? "From the mapped outline shape"
            : undefined,
  });
  if (ridgeAlong) {
    attributes.push({
      field: "Roof ridge",
      value: inferred?.kind === "wings" ? "Multi-wing" : ridgeAlong === "depth" ? "Along the long axis" : "Across the short axis",
      from: roofFrom,
      note: inferred?.kind === "wings" ? "Split at the footprint jog" : aerialCue?.ridgeBearingDeg != null ? "Aligned with the aerial roof blob" : undefined,
    });
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
  } else if (buildingOnLot && lot?.basement === true) {
    basement = true;
    attributes.push({ field: "Basement", value: "Yes", from: "map", note: "NYC tax lot lists a basement" });
  } else if (buildingOnLot && lot?.basement === false) {
    basement = false;
    attributes.push({ field: "Basement", value: "No", from: "map", note: "NYC tax lot lists no basement" });
  } else {
    attributes.push({
      field: "Basement", value: basement ? "Yes" : "No", from: "estimated",
      note: basement ? "Most houses this far north have one" : "Uncommon in this region",
    });
  }

  // 5. Build the 3D model.
  step("build", "active");
  const streetDir = osm?.roadDir ?? null;
  const houseCenter = b ? polygonCentroid(b.ring) : ([0, 0] as Point);
  const parcelLocal = lot ? lot.ring.map((p) => toLocal(origin, p)) : null;
  const reach = footprint ? compoundReach(footprint) : 40;
  const garageRing = pickGarage(
    (osm?.structures ?? []).map((s) => ({ id: s.id, tag: s.tags.building ?? "", ring: s.ring, area: s.area })),
    houseCenter,
    parcelLocal,
    reach,
  );
  const garageAt = garageRing
    ? (() => {
        const c = polygonCentroid(garageRing);
        return [c[0] - houseCenter[0], c[1] - houseCenter[1]] as Point;
      })()
    : null;
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
    ridgeAlong,
    roofPlan,
    garageAt,
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

  const originShift = b ? polygonCentroid(b.ring) : ([0, 0] as Point);
  const shift = (ring: Point[]) => ring.map(([x, y]) => [x - originShift[0], y - originShift[1]] as Point);
  const access = accessFeatures({
    footprint: built.model.footprint,
    streetDir,
    roads: (osm?.roads ?? []).map((r) => ({ name: r.name, pts: shift(r.pts) })),
    garage: garageRing ? shift(garageRing) : null,
  });
  const compound = assembleCompound({
    mainId: b?.id ?? null,
    mainRing: built.model.footprint,
    structures: (osm?.structures ?? []).map((s) => ({ id: s.id, tag: s.tags.building ?? "", ring: shift(s.ring), area: s.area })),
    fences: (osm?.fences ?? []).map(shift),
    pools: (osm?.pools ?? []).map(shift),
    parking: (osm?.parking ?? []).map(shift),
    parcel: lot ? shift(lot.ring.map((p) => toLocal(origin, p))) : null,
    aerial: siteBoxes.flatMap((box) => {
      const polygon = boxToPolygon(box, aerialHalf);
      return polygon ? [{ kind: box.kind, label: box.label, polygon }] : [];
    }),
  });
  const kept = access.some((f) => f.kind === "driveway")
    ? compound.features.filter((f) => !(f.kind === "driveway" && f.source === "aerial"))
    : compound.features;
  built.model.compound = { features: [...kept, ...access], basis: "compound-v2" };
  if (!verified && built.model.interior) {
    if (compound.features.some((f) => f.kind === "yard" && f.source === "parcel")) {
      built.model.interior.notes.push("The yard is the city tax lot. The street and driveway follow the mapped road.");
    } else if (compound.features.some((f) => f.kind === "yard")) {
      built.model.interior.notes.push("The site outline wraps the mapped building and nearby outbuildings.");
    }
    const roomNote = built.notes.find((n) => n.startsWith("About "));
    if (roomNote) built.model.interior.notes.push(roomNote);
  }
  if (access.some((f) => f.kind === "driveway")) {
    warnings.push(
      garageRing
        ? `The driveway runs from ${osm?.roadName ?? "the street"} to the garage, the way the lot is laid out on the map.`
        : `The driveway runs from ${osm?.roadName ?? "the street"} to the front of the house.`,
    );
  }
  const mappedOutbuildings = compound.features.filter((f) => f.kind === "garage" || f.kind === "shed");
  if (mappedOutbuildings.length) {
    const row = attributes.find((a) => a.field === "Garage");
    if (row && (row.from === "estimated" || row.value.startsWith("Detached"))) {
      row.value = [...new Set(mappedOutbuildings.map((f) => f.label))].join(", ");
      row.from = "map";
      row.note = "Drawn beside the house from the map";
    }
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
  const shown = built.model.compound?.features ?? [];
  const lotLabels = [...new Set(shown.map((f) => f.label))];
  sources.push({
    id: "compound",
    name: "Yard and outbuildings",
    status: shown.length ? "used" : "skipped",
    detail: lotLabels.length ? lotLabels.slice(0, 8).join(", ") : "Nothing around the house was mapped.",
  });
  step("build", "done");

  const result: ScanResult = {
    model: built.model,
    sources,
    attributes,
    warnings,
    images: aerial ? [{ label: "Aerial view · Esri World Imagery", url: `data:${aerial.mime};base64,${aerial.base64}` }] : [],
    summary: {
      width: built.width, depth: built.depth, area: Math.round(footprint ? polygonArea(footprint) : built.width * built.depth), facing: built.facing, stories, streetDir,
      nearby: osm?.nearby ?? [],
      match: osm?.chosenBy === "nearest" || osm?.chosenBy === "in-view-direction" ? "nearest" : osm?.chosenBy === "contains-point" ? "point" : "address",
    },
    createdAt: new Date().toISOString(),
  };
  // Don't save scans where the map server was down; the next try should get the real outline.
  if (osm) await store.put(result);
  emit({ type: "result", result, cached: false });
}
