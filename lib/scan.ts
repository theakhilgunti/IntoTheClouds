/**
 * The scan pipeline: address or photo location -> building outline -> imagery -> photo reading -> 3D model.
 * Every step reports what it used, so the UI can show exactly where each fact came from.
 */
import { fromLocal, pointInPolygon, polygonArea, polygonCentroid, toLocal, type LatLng } from "./geo";
import { geocode, nominatimBuildingId } from "./geocode";
import { parseStreetAddress, parseStreetName } from "./address";
import { lookupBuilding, type OsmContext } from "./overpass";
import { pinnedWayId } from "./pins";
import { verifiedInterior } from "./interiors";
import { aerialImage, googleSatelliteImage, type Image } from "./imagery";
import { describeHouse, describeSite, geminiAvailable, geminiModel, type HouseFacts } from "./vision";
import {
  accessFeatures,
  assembleCompound,
  boxToPolygon,
  buildLotGrade,
  crossVerifySiteFeatures,
  entryStairFeatures,
  pickGarage,
  roadReach,
  SITE_REACH_MIN_M,
  siteReach,
} from "./compound-geom";
import { fetchSiteDem, withDem } from "./elevation";
import { fetchStreetViewFacade } from "./streetview";
import { inNyc, lookupParcel, type ParcelHit } from "./parcel";
import { buildingUseFromAssessor, lookupVgsi, type VgsiHit } from "./vgsi";
import {
  buildHouse,
  buildingUseFromTags,
  isGenericResidentialUse,
  maxStoriesForUse,
  planWordForUse,
  rebuildFloorCirculation,
  type GarageSide,
} from "./layout";
import { fetchIndoorRooms, overlayIndoorOnModel } from "./indoor-osm";
import { fingerprintLayout, softCheckTypology } from "./plan-typology";
import { cubicasaHousePrior } from "./cubicasa-priors";
import { analyzeAerialRoof } from "./aerial-roof";
import { analyzeAerialSite } from "./aerial-site";
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

/** Public / campus buildings sometimes have OSM Simple Indoor — houses almost never do. */
const INDOOR_LIKELY = new Set([
  "school", "university", "college", "hospital", "library", "public", "civic", "office",
  "commercial", "retail", "hotel", "dormitory", "apartments",
]);

function shouldFetchIndoor(tags: Record<string, string>): boolean {
  if (Object.keys(tags).some((k) => k === "indoor" || k.startsWith("indoor:") || k === "room")) return true;
  return INDOOR_LIKELY.has(tags.building ?? "");
}

const NOT_A_HOUSE = new Set([
  "apartments", "commercial", "retail", "industrial", "office", "school", "church", "university",
  "college", "library", "hospital", "warehouse", "hotel", "civic", "public", "dormitory",
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
  const queryAddress = input.address?.trim() ?? "";
  let address = queryAddress;
  // Keep the user's street even when Nominatim returns a street-only label without a house number.
  const queryStreet = parseStreetName(queryAddress);
  let streetOnlyGeocode = false;
  if (address) {
    const g = await geocode(address, sources);
    if (!g) throw new ScanError("We couldn't find that address. Check the spelling and include the city and state.");
    origin = g;
    geocodedWay = g.wayId ?? null;
    streetOnlyGeocode = !!g.streetOnly;
    address = g.matched;
    step("locate", "done", g.matched);
    if (streetOnlyGeocode) {
      warnings.push(
        "The map only matched the street name — not this house number — so the pin sits on the road and we use the closest mapped building. Confirm it's yours; the curb follows that building.",
      );
    }
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
  // Prefer the user's typed address for street/house matching — geocode labels often drop the number.
  const outlineAddress = queryAddress || address;
  try {
    const wayId =
      input.wayId ?? pinnedWayId(outlineAddress) ?? geocodedWay ?? (outlineAddress ? await nominatimBuildingId(outlineAddress) : null);
    osm = await lookupBuilding(origin, input.heading, { address: outlineAddress, wayId, force: input.wayId != null });
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
      warnings.push(
        streetOnlyGeocode
          ? "No building is tagged with this house number on OpenStreetMap, so we used the closest outline to the street. It may be a neighbor — use Wrong house? if needed."
          : "We couldn't match this address to a specific mapped building, so we used the closest one. It may be a neighbor. Check it against the aerial photo.",
      );
    }
    if (NOT_A_HOUSE.has(b.tags.building)) {
      const useHint = buildingUseFromTags(b.tags);
      if (useHint === "house") {
        warnings.push(`OpenStreetMap lists this as "${b.tags.building}", not a house. The room layout assumes a home.`);
      } else {
        warnings.push(`OpenStreetMap lists this as "${b.tags.building}". Using a typical ${useHint} room layout (estimated).`);
      }
    }
    if (!address && b.tags["addr:street"]) {
      address = [b.tags["addr:housenumber"], b.tags["addr:street"], b.tags["addr:city"]].filter(Boolean).join(" ");
    }
  } else {
    id = `pt-${origin.lat.toFixed(5)}_${origin.lng.toFixed(5)}`;
    if (osm) {
      sources.push({ id: "osm", name: "OpenStreetMap buildings", status: "failed", detail: "No building outline is mapped at this spot." });
    }
  }

  // Vision (gis.vgsi.com) assessor maps — building shell + lot/program cues when the town is covered.
  let vgsi: VgsiHit | null = null;
  try {
    vgsi = await lookupVgsi(center, address);
  } catch (e) {
    sources.push({
      id: "vgsi",
      name: "Vision assessor (VGSI)",
      status: "failed",
      detail: String(e).slice(0, 160),
    });
  }
  if (vgsi && !footprint && vgsi.buildingRing && vgsi.buildingRing.length >= 3) {
    const ringLocal = vgsi.buildingRing.map((p) => toLocal(origin, p));
    const c = polygonCentroid(ringLocal);
    center = fromLocal(origin, c);
    footprint = ringLocal.map(([x, y]) => [x - c[0], y - c[1]] as Point);
    id = `vgsi-${vgsi.municipality.replace(/\s+/g, "_")}-${center.lat.toFixed(5)}_${center.lng.toFixed(5)}`;
    sources.push({
      id: "vgsi",
      name: "Vision assessor (VGSI)",
      status: "used",
      detail: `Building footprint from ${vgsi.detail}`,
    });
    step("outline", "done", "Vision assessor footprint");
    warnings.push(
      "No OpenStreetMap building outline here — used the Vision Government Solutions assessor building footprint. Interior rooms are still estimated.",
    );
  } else if (!footprint) {
    warnings.push(
      osm
        ? "No building outline is mapped here, so a typical 11 × 9 m house was used. Size and shape are estimates."
        : "The map server didn't respond, so a typical 11 × 9 m house was used. Try Re-scan in a minute.",
    );
    step("outline", "skipped", osm ? "No outline mapped, using a typical size" : "Map unavailable, using a typical size");
    if (vgsi) {
      sources.push({
        id: "vgsi",
        name: "Vision assessor (VGSI)",
        status: "used",
        detail: `No building polygon; ${vgsi.detail}`,
      });
    }
  } else if (vgsi) {
    sources.push({
      id: "vgsi",
      name: "Vision assessor (VGSI)",
      status: "used",
      detail: vgsi.detail,
    });
  }

  // Saved scan? Then we're done, no imagery or AI calls needed.
  if (!input.rescan) {
    const saved = await store.get(id);
    // Empty shells, and address scans from before the lot was drawn, get rebuilt.
    const stale =
      !!saved &&
      (saved.model.source === "address" || saved.model.source === "photo") &&
      (saved.model.compound?.basis !== "compound-v81" || saved.model.roof?.basis !== "roof-v4");
    if (saved && saved.model.interior?.status !== "unknown" && !stale) {
      for (const k of ["imagery", "vision", "build"] as StepKey[]) step(k, "done", "Saved scan");
      emit({ type: "result", result: saved, cached: true });
      return;
    }
  }

  // City lot: NYC MapPLUTO first; otherwise Vision parcel when available.
  let lot: ParcelHit | null = null;
  let buildingOnLot = false;
  if (inNyc(center)) {
    try {
      const byAddress = address ? await lookupParcel(origin, address) : null;
      const addressRing = byAddress ? byAddress.ring.map((p) => toLocal(origin, p)) : null;
      const atBuilding = b ? polygonCentroid(b.ring) : footprint ? ([0, 0] as Point) : null;
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
  } else if (vgsi?.parcelRing && vgsi.parcelRing.length >= 3) {
    lot = {
      address: vgsi.address ?? "",
      ring: vgsi.parcelRing,
      numFloors: vgsi.stories,
      numBuildings: null,
      basement: null,
    };
    const atBuilding = footprint ? ([0, 0] as Point) : b ? polygonCentroid(b.ring) : null;
    if (lot && atBuilding) {
      // Footprint is centered at model origin after shift; compare parcel in origin frame vs footprint center.
      const parcelLocal = lot.ring.map((p) => toLocal(origin, p));
      const fpCenter: Point = footprint
        ? (() => {
            const ring = vgsi!.buildingRing?.map((p) => toLocal(origin, p)) ?? b?.ring;
            return ring ? polygonCentroid(ring) : [0, 0];
          })()
        : atBuilding;
      buildingOnLot = pointInPolygon(fpCenter, parcelLocal);
    }
    sources.push({
      id: "parcel",
      name: "Vision tax parcel",
      status: "used",
      detail: `${lot.address || vgsi.municipality} parcel from Vision assessor.`,
    });
  }

  // 3. Aerial imagery (+ Street View / Google sat only when Gemini will need them).
  step("imagery", "active");
  let aerial: Image | null = null;
  let aerialHalf = 40;
  const tags = b?.tags ?? {};
  const plutoStories = buildingOnLot && lot?.numFloors != null ? storiesFromPluto(lot.numFloors) : null;
  // Gemini (and Street View / Google sat) only when the user uploaded a photo.
  const skipGemini = !input.photo;
  const wantHalf = footprint ? siteReach(footprint) : SITE_REACH_MIN_M;
  const emptyStreetView = {
    shots: [] as Awaited<ReturnType<typeof fetchStreetViewFacade>>["shots"],
    pano: center,
    lookHeading: 0,
    status: "skipped" as const,
    detail: "Skipped — photo AI runs only when you upload a house photo.",
  };
  const aerialP = aerialImage(center, wantHalf)
    .then((shot) => ({ ok: true as const, shot }))
    .catch((e: unknown) => ({ ok: false as const, error: e }));
  const streetViewP =
    skipGemini || !geminiAvailable()
      ? Promise.resolve(emptyStreetView)
      : fetchStreetViewFacade(center, { streetDir: osm?.roadDir ?? null }).catch((e) => {
          console.warn("Street View fetch failed", e);
          return {
            shots: [] as Awaited<ReturnType<typeof fetchStreetViewFacade>>["shots"],
            pano: center,
            lookHeading: 0,
            status: "failed" as const,
            detail: String(e).slice(0, 160),
          };
        });
  const [aerialRes, streetView] = await Promise.all([aerialP, streetViewP]);
  if (aerialRes.ok) {
    aerial = aerialRes.shot.image;
    aerialHalf = aerialRes.shot.halfSize;
    sources.push({
      id: "esri",
      name: "Esri World Imagery",
      status: "used",
      detail: `Aerial photo (~${Math.round(aerialHalf)} m half-width) centered on the building.`,
    });
    step("imagery", "done");
  } else {
    sources.push({ id: "esri", name: "Esri World Imagery", status: "failed", detail: String(aerialRes.error) });
    step("imagery", "skipped", "Imagery unavailable");
  }

  const mapFacts = [
    b ? `Outline area: ${Math.round(b.area)} m²` : "No mapped outline",
    tags.building ? `Building type: ${tags.building}` : null,
    tags["building:levels"] ? `Levels: ${tags["building:levels"]}` : null,
    tags["roof:shape"] ? `Roof shape: ${tags["roof:shape"]}` : null,
    tags.height ? `Height: ${tags.height} m` : null,
    tags["building:material"] ? `Material: ${tags["building:material"]}` : null,
  ].filter(Boolean).join("\n");

  // Optional Google Maps Static satellite — only when Gemini site read will use it.
  let googleSat: Image | null = null;
  if (aerial && !skipGemini && geminiAvailable()) {
    googleSat = await googleSatelliteImage(center, aerialHalf).catch(() => null);
    if (googleSat) {
      sources.push({
        id: "google-sat",
        name: "Google Maps satellite",
        status: "used",
        detail: "Static satellite tile used to cross-check site structures with Esri imagery.",
      });
    } else if (process.env.GOOGLE_MAPS_API_KEY) {
      sources.push({
        id: "google-sat",
        name: "Google Maps satellite",
        status: "failed",
        detail: "GOOGLE_MAPS_API_KEY is set but the static map request failed.",
      });
    }
  }

  if (!skipGemini && (streetView.status !== "skipped" || process.env.GOOGLE_MAPS_API_KEY)) {
    sources.push({
      id: "streetview",
      name: "Google Street View",
      status: streetView.status,
      detail: streetView.detail,
    });
  }

  // 4. Read the house from the photos (Gemini) — only when a user photo was uploaded.
  step("vision", "active");
  let facts: HouseFacts | null = null;
  const streetViewImages = streetView.shots.map((s) => s.image);
  const sitePromise =
    !skipGemini && geminiAvailable() && aerial
      ? describeSite(aerial, googleSat).catch((e) => {
          console.warn("aerial site read failed", e);
          return [];
        })
      : Promise.resolve([]);
  if (skipGemini) {
    sources.push({
      id: "gemini",
      name: "Google Gemini (photo reading)",
      status: "skipped",
      detail: "No user photo — floors/roof come from map data or typical values (faster scan).",
    });
    step("vision", "skipped", "No photo uploaded");
  } else if (!geminiAvailable()) {
    sources.push({
      id: "gemini", name: "Google Gemini (photo reading)", status: "skipped",
      detail: "No GEMINI_API_KEY configured, so floors, roof and garage come from map data or typical values.",
    });
    step("vision", "skipped", "Not configured");
  } else if (!input.photo && !aerial && streetViewImages.length === 0) {
    sources.push({ id: "gemini", name: "Google Gemini (photo reading)", status: "skipped", detail: "No images to read." });
    step("vision", "skipped", "No images");
  } else {
    try {
      facts = await describeHouse({
        photo: input.photo ?? null,
        aerial,
        streetViews: streetViewImages,
        facts: mapFacts,
      });
      const views = [
        input.photo && "your photo",
        aerial && "the aerial photo",
        googleSat && "Google satellite",
        streetViewImages.length > 0 && `Street View (${streetViewImages.length})`,
      ].filter(Boolean);
      sources.push({
        id: "gemini", name: `Google Gemini (${geminiModel()})`, status: "used",
        detail: `Read ${views.join(" and ")}. ` +
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
  const jpegSiteCues = aerial ? analyzeAerialSite(aerial, aerialHalf) : [];
  const sure = facts && facts.confidence >= 0.35 ? facts : null;

  // Merge: map data and photos first, typical values last. Record where each value came from.
  let stories = 2;
  const osmLevels = parseInt(tags["building:levels"] ?? "", 10);
  const osmHeight = parseFloat(tags.height ?? "");
  const photoNote = streetViewImages.length
    ? input.photo
      ? "User photo + Street View facade"
      : "Street View facade (+ aerial when available)"
    : undefined;
  if (input.photo && sure) {
    stories = sure.stories;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "photos", note: photoNote });
  } else if (osmLevels >= 1 && osmLevels <= 12) {
    stories = osmLevels;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "map", note: "OpenStreetMap building:levels" });
  } else if (plutoStories) {
    stories = plutoStories;
    attributes.push({
      field: "Floors above ground",
      value: String(stories),
      from: "map",
      note: inNyc(center) ? `NYC tax lot lists ${lot!.numFloors}` : `Vision assessor lists ${lot!.numFloors}`,
    });
  } else if (vgsi?.stories != null && vgsi.stories >= 1) {
    stories = vgsi.stories;
    attributes.push({
      field: "Floors above ground",
      value: String(stories),
      from: "map",
      note: `Vision assessor (${vgsi.municipality})`,
    });
  } else if (osmHeight > 2) {
    stories = storiesFromHeight(osmHeight);
    attributes.push({ field: "Floors above ground", value: String(stories), from: "map", note: `From mapped height ${osmHeight} m` });
  } else if (sure) {
    stories = sure.stories;
    attributes.push({ field: "Floors above ground", value: String(stories), from: "photos", note: photoNote });
  } else {
    attributes.push({ field: "Floors above ground", value: "2", from: "estimated", note: "Most common for houses in the area" });
  }
  // Cap by program: houses stay compact; schools/offices/multi-unit may show more levels + public stair links.
  const assessorUseEarly = buildingUseFromAssessor({
    style: vgsi?.style,
    occupancy: vgsi?.occupancy,
    useDesc: vgsi?.useDesc,
  });
  const buildingUsePreview =
    assessorUseEarly && (isGenericResidentialUse(b?.tags) || !b)
      ? assessorUseEarly
      : buildingUseFromTags(b?.tags);
  const storyCap = maxStoriesForUse(buildingUsePreview);
  if (stories > storyCap) {
    warnings.push(`This building has ${stories} floors; the model shows the first ${storyCap}.`);
    attributes[attributes.length - 1].value = `${stories} (showing ${storyCap})`;
    stories = storyCap;
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
    attributes.push({
      field: "Garage",
      value: `Attached, ${garage} side`,
      from: "photos",
      note: streetViewImages.length ? "Cross-checked with Street View facade" : undefined,
    });
  } else if (sure && sure.garage === "detached") {
    attributes.push({
      field: "Garage",
      value: "Detached (not modeled)",
      from: "photos",
      note: streetViewImages.length ? "Cross-checked with Street View facade" : undefined,
    });
  } else if (sure && sure.garage === "none") {
    attributes.push({
      field: "Garage",
      value: "None",
      from: "photos",
      note: streetViewImages.length ? "No garage door visible on Street View / photos" : undefined,
    });
  } else {
    attributes.push({ field: "Garage", value: "None shown", from: "estimated", note: "Couldn't tell from the data" });
  }

  if (sure && sure.entry && sure.entry !== "unknown") {
    const doorT = sure.front_door_t != null ? Math.round(sure.front_door_t * 100) : null;
    attributes.push({
      field: "Front entry",
      value:
        sure.entry === "center"
          ? "Center of facade"
          : sure.entry === "left"
            ? "Left side of facade"
            : "Right side of facade",
      from: "photos",
      note: [
        streetViewImages.length ? "Street View / street photos" : "Street photos",
        doorT != null ? `door ~${doorT}% along facade` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (sure && sure.front_windows != null && sure.front_windows > 0) {
    attributes.push({
      field: "Front windows",
      value: String(sure.front_windows),
      from: "photos",
      note: streetViewImages.length
        ? "Counted on Street View; used to nudge room bays"
        : "Counted on street photos; used to nudge room bays",
    });
  }
  if (sure && sure.side_entry && sure.side_entry !== "unknown") {
    attributes.push({
      field: "Side entry",
      value:
        sure.side_entry === "none"
          ? "None visible"
          : sure.side_entry === "left"
            ? "Left flank"
            : "Right flank",
      from: "photos",
      note: streetViewImages.length ? "Street View facade check" : undefined,
    });
  }
  if (sure && sure.porch && sure.porch !== "unknown") {
    attributes.push({
      field: "Porch",
      value: sure.porch === "yes" ? "Visible" : "None visible",
      from: "photos",
      note: streetViewImages.length ? "Street View facade check" : undefined,
    });
  }

  let basement = center.lat > 37;
  if (sure && (sure.basement === "visible" || sure.basement === "likely")) {
    basement = true;
    attributes.push({
      field: "Basement",
      value: "Yes",
      from: "photos",
      note:
        sure.basement === "visible"
          ? streetViewImages.length
            ? "Visible basement windows on Street View / photos"
            : "Visible in photo"
          : "Likely from the photos",
    });
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
  const reach = footprint ? siteReach(footprint) : SITE_REACH_MIN_M;
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

  let buildingUse = buildingUseFromTags(b?.tags);
  const assessorUse = buildingUseFromAssessor({
    style: vgsi?.style,
    occupancy: vgsi?.occupancy,
    useDesc: vgsi?.useDesc,
  });
  if (assessorUse && (isGenericResidentialUse(b?.tags) || !b) && assessorUse !== buildingUse) {
    buildingUse = assessorUse;
    attributes.push({
      field: "Building program",
      value: planWordForUse(buildingUse),
      from: "map",
      note: `Vision assessor style/use (${[vgsi?.style, vgsi?.occupancy, vgsi?.useDesc].filter(Boolean).join(", ")})`,
    });
  }
  const planWord = planWordForUse(buildingUse);
  if (vgsi?.beds != null || vgsi?.baths != null || vgsi?.rooms != null) {
    const bits = [
      vgsi.beds != null ? `${vgsi.beds} bed` : null,
      vgsi.baths != null ? `${vgsi.baths} bath` : null,
      vgsi.rooms != null ? `${vgsi.rooms} rooms` : null,
    ].filter(Boolean);
    attributes.push({
      field: "Assessor room counts",
      value: bits.join(" · "),
      from: "map",
      note: "Vision card totals — used as shell/program cues, not a measured floor plan",
    });
  }
  const footprintArea = b?.area ?? (footprint ? polygonArea(footprint) : 100);
  const cubiPrior =
    buildingUse === "house"
      ? cubicasaHousePrior(footprintArea, stories, vgsi?.beds ?? null, vgsi?.baths ?? null)
      : null;
  // Prefer assessor bed count for bay rhythm; else CubiCasa5K size→program prior.
  const layoutBays =
    buildingUse === "house" && vgsi?.beds != null && vgsi.beds >= 2 && vgsi.beds <= 6
      ? Math.round(vgsi.beds)
      : cubiPrior?.bays ?? null;
  if (cubiPrior && buildingUse === "house") {
    sources.push({
      id: "cubicasa5k",
      name: "CubiCasa5K priors",
      status: "used",
      detail: cubiPrior.note,
    });
    attributes.push({
      field: "Estimated room program",
      value: `${cubiPrior.targetBeds} bed · ${cubiPrior.targetBaths} bath · ${cubiPrior.bays} bay`,
      from: "estimated",
      note: cubiPrior.note,
    });
  }
  const verified = verifiedInterior(id);
  let built = buildHouse({
    id,
    source: input.address ? "address" : "photo",
    confidence: Math.round(confidence * 100) / 100,
    address,
    lat: center.lat,
    lng: center.lng,
    footprint,
    streetDir,
    stories,
    basement: buildingUse === "house" ? basement : false,
    garage: buildingUse === "house" ? garage : "none",
    roof,
    ridgeAlong,
    roofPlan,
    garageAt: buildingUse === "house" ? garageAt : null,
    use: buildingUse,
    bays: layoutBays,
    facade:
      buildingUse === "house" && sure
        ? {
            entry: sure.entry,
            frontDoorT: sure.front_door_t ?? null,
            frontWindows: sure.front_windows ?? null,
            sideEntry: sure.side_entry,
          }
        : null,
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

  // Kick off DEM while indoor + compound assemble (roadReach ≈ final outdoor disc).
  const originShiftEarly = b ? polygonCentroid(b.ring) : ([0, 0] as Point);
  const modelGeoOrigin = fromLocal(origin, originShiftEarly);
  const demHalfGuess = footprint ? Math.max(roadReach(footprint, parcelLocal), 110) : 110;
  const demPromise = fetchSiteDem({ geoOrigin: modelGeoOrigin, halfExtentM: demHalfGuess }).catch((e) => {
    console.warn("Site DEM fetch failed", e);
    return null;
  });

  let indoorUsed = 0;
  let typologyNote: string | null = null;
  if (!verified) {
    // Cross-verify: OSM Simple Indoor when mapped, else typology soft-check vs public plan stats.
    const tryIndoor = shouldFetchIndoor(tags);
    if (!tryIndoor) {
      sources.push({
        id: "osm-indoor",
        name: "OpenStreetMap indoor",
        status: "skipped",
        detail: "Skipped indoor Overpass for this building type (rare for houses).",
      });
    } else {
      try {
        // Fetch relative to building centroid so indoor rings share the model footprint frame.
        const rawIndoor = await fetchIndoorRooms(center, Math.max(40, Math.sqrt(b?.area ?? 100) * 1.2));
        const overlay = overlayIndoorOnModel(built.model, rawIndoor);
        if (overlay) {
          // Re-cut walls/doors to the indoor rooms so nothing stays sealed behind stale template walls.
          built.model = {
            ...overlay.model,
            floors: overlay.model.floors.map((f) => rebuildFloorCirculation(f)),
          };
          indoorUsed = overlay.used;
          sources.push({
            id: "osm-indoor",
            name: "OpenStreetMap indoor",
            status: "used",
            detail: overlay.note,
          });
          attributes.push({
            field: "Interior cross-check",
            value: `${overlay.used} OSM indoor rooms`,
            from: "map",
            note: "Simple Indoor geometry overlapping this footprint",
          });
        } else {
          sources.push({
            id: "osm-indoor",
            name: "OpenStreetMap indoor",
            status: "skipped",
            detail: rawIndoor.length
              ? "Indoor ways mapped nearby, but not enough overlap this footprint."
              : "No OSM Simple Indoor rooms mapped near this building.",
          });
        }
      } catch (e) {
        sources.push({
          id: "osm-indoor",
          name: "OpenStreetMap indoor",
          status: "failed",
          detail: String(e).slice(0, 160),
        });
      }
    }

    if (indoorUsed === 0) {
      const fp = fingerprintLayout(built.model.floors, buildingUse, built.width, built.depth);
      const check = softCheckTypology(fp);
      typologyNote = check.note;
      if (!check.ok && check.nudgeBays != null) {
        built = buildHouse({
          id,
          source: input.address ? "address" : "photo",
          confidence: Math.round(confidence * 100) / 100,
          address,
          lat: center.lat,
          lng: center.lng,
          footprint,
          streetDir,
          stories,
          basement: buildingUse === "house" ? basement : false,
          garage: buildingUse === "house" ? garage : "none",
          roof,
          ridgeAlong,
          roofPlan,
          garageAt: buildingUse === "house" ? garageAt : null,
          use: buildingUse,
          bays: check.nudgeBays,
          facade:
            buildingUse === "house" && sure
              ? {
                  entry: sure.entry,
                  frontDoorT: sure.front_door_t ?? null,
                  frontWindows: sure.front_windows ?? null,
                  sideEntry: sure.side_entry,
                }
              : null,
        });
        warnings.push(check.note);
      } else if (!check.ok) {
        warnings.push(check.note);
      }
      attributes.push({
        field: "Interior cross-check",
        value: check.ok ? "Typology OK" : "Typology soft-nudge",
        from: "estimated",
        note: check.note,
      });
      sources.push({
        id: "typology",
        name: "Plan typology check",
        status: "used",
        detail: check.note,
      });
    }

    if (indoorUsed === 0) {
      built.model.interior = {
        status: "estimated",
        source: `typical ${planWord} layout inside the mapped outline`,
        reasons: [],
        knownLevels: [],
        notes: [
          buildingUse === "house"
            ? "Rooms follow a common house plan. They are not a measured scan of this house."
            : `Rooms follow a typical ${planWord} plan for OSM building=${b?.tags.building ?? "yes"}. They are not a measured scan.`,
          ...(typologyNote ? [typologyNote] : []),
        ],
      };
    }
    // When indoorUsed > 0, overlayIndoorOnModel already set interior metadata.
    attributes.push({
      field: "Building type",
      value: b?.tags.building ? String(b.tags.building) : planWord,
      from: b?.tags.building ? "map" : "estimated",
      note: `Interior uses a typical ${planWord} room layout`,
    });
    warnings.push(...built.notes);
  } else {
    warnings.push(...built.notes);
  }

  const originShift = originShiftEarly;
  const shift = (ring: Point[]) => ring.map(([x, y]) => [x - originShift[0], y - originShift[1]] as Point);
  const geminiAerial = siteBoxes.flatMap((box) => {
    const polygon = boxToPolygon(box, aerialHalf);
    return polygon ? [{ kind: box.kind, label: box.label, polygon, confidence: 0.7 }] : [];
  });
  const aerialForAssemble = [
    ...geminiAerial.map(({ kind, label, polygon }) => ({ kind, label, polygon })),
    ...jpegSiteCues.map((c) => ({ kind: c.kind, label: c.label, polygon: c.polygon })),
  ];
  const aboveGrade = built.model.floors.filter((f) => f.level >= 0);
  const topFloor = aboveGrade.length
    ? aboveGrade.reduce((a, b) => (a.level >= b.level ? a : b))
    : null;
  const mainEaveHeight = topFloor ? topFloor.elevation + topFloor.height : Math.max(2.7, stories * 2.75);
  // Assemble neighbors first so street/DEM radius matches the capped neighbor cloud.
  const compound = assembleCompound({
    mainId: b?.id ?? null,
    mainRing: built.model.footprint,
    structures: (osm?.structures ?? []).map((s) => {
      const levelsRaw = parseFloat(s.tags["building:levels"] ?? "");
      const heightRaw = parseFloat(String(s.tags.height ?? "").replace(/m$/i, "").trim());
      const num = s.tags["addr:housenumber"];
      const street = s.tags["addr:street"];
      const city = s.tags["addr:city"];
      const address =
        num && street ? (city ? `${num} ${street}, ${city}` : `${num} ${street}`) : num ? String(num) : null;
      return {
        id: s.id,
        tag: s.tags.building ?? "",
        ring: shift(s.ring),
        area: s.area,
        levels: Number.isFinite(levelsRaw) && levelsRaw >= 1 ? levelsRaw : null,
        heightM: Number.isFinite(heightRaw) && heightRaw >= 2 ? heightRaw : null,
        address,
      };
    }),
    fences: (osm?.fences ?? []).map(shift),
    pools: (osm?.pools ?? []).map(shift),
    parking: (osm?.parking ?? []).map(shift),
    parcel: lot ? shift(lot.ring.map((p) => toLocal(origin, p))) : null,
    aerial: aerialForAssemble,
    mainEaveHeight,
    streetDir,
    trees: (osm?.trees ?? []).map((p) => [p[0] - originShift[0], p[1] - originShift[1]] as Point),
  });
  const avoidRings = [
    built.model.footprint,
    ...compound.features
      .filter((f) => f.kind === "neighbor" || f.kind === "garage" || f.kind === "shed")
      .map((f) => f.polygon),
  ].filter((ring) => ring.length >= 3);
  const preferStreet =
    queryStreet ??
    parseStreetName(outlineAddress) ??
    parseStreetName(address) ??
    osm?.roadName ??
    null;
  const neighborRings = compound.features.filter((f) => f.kind === "neighbor").map((f) => f.polygon);
  const access = accessFeatures({
    footprint: built.model.footprint,
    streetDir,
    roads: (osm?.roads ?? []).map((r) => ({ name: r.name, pts: shift(r.pts) })),
    garage: garageRing ? shift(garageRing) : null,
    hydrants: (osm?.hydrants ?? []).map((p) => [p[0] - originShift[0], p[1] - originShift[1]] as Point),
    trafficSignals: (osm?.trafficSignals ?? []).map(
      (p) => [p[0] - originShift[0], p[1] - originShift[1]] as Point,
    ),
    stopSigns: (osm?.stopSigns ?? []).map((p) => [p[0] - originShift[0], p[1] - originShift[1]] as Point),
    radiusM: compound.outdoorReach,
    avoidRings,
    neighborRings,
    preferStreet,
  });
  const verifiedSite = crossVerifySiteFeatures({
    features: compound.features,
    aerialCues: [...geminiAerial, ...jpegSiteCues],
    geminiGarage: sure?.garage,
  });
  const kept = access.some((f) => f.kind === "driveway")
    ? verifiedSite.filter((f) => !(f.kind === "driveway" && f.source === "aerial"))
    : verifiedSite;
  const planeGrade = buildLotGrade(built.model.footprint, streetDir);
  // DEM was started earlier (parallel with indoor/assemble); outdoorReach ≈ demHalfGuess.
  const dem = await demPromise;
  const grade = withDem(planeGrade, dem);
  const exits: Point[] = [];
  for (const floor of built.model.floors) {
    if (floor.level !== 0) continue;
    for (const door of floor.doors) {
      if (!door.exit) continue;
      const wall = floor.walls.find((w) => w.id === door.wallId);
      if (!wall) continue;
      exits.push([
        wall.a[0] + (wall.b[0] - wall.a[0]) * door.t,
        wall.a[1] + (wall.b[1] - wall.a[1]) * door.t,
      ]);
    }
  }
  const entrySteps = entryStairFeatures({ streetDir, grade, exits });
  const sceneR = compound.outdoorReach;
  const insideScene = (poly: Point[]) => {
    if (poly.length < 1) return false;
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p[0];
      sy += p[1];
    }
    const n = poly.length;
    return Math.hypot(sx / n, sy / n) <= sceneR + 0.5;
  };
  built.model.compound = {
    features: [...kept, ...access, ...entrySteps].filter(
      (f) => f.id === "terrain-radius" || insideScene(f.polygon),
    ),
    basis: "compound-v81",
    grade: grade ?? undefined,
  };
  if (grade?.dem) {
    const zs = grade.dem.z;
    const drop = Math.max(...zs.map(Math.abs), 0);
    attributes.push({
      field: "Site elevation",
      value: drop >= 1 ? `~${Math.round(drop)} m relief (DEM)` : "Nearly level (DEM)",
      from: "map",
      note: `Outdoor meshes follow ${grade.dem.source}; house slab stays at grade zero`,
    });
    sources.push({
      id: "dem",
      name: "Terrain elevation",
      status: "used",
      detail: `${grade.dem.cols}×${grade.dem.rows} samples @ ${grade.dem.cell} m (${grade.dem.source}).`,
    });
  } else if (grade) {
    attributes.push({
      field: "Lot grade",
      value: `~${Math.round(grade.slope * 100)}% toward street`,
      from: "estimated",
      note: "DEM unavailable — mild street-side slope with entry stairs and ground pads",
    });
    sources.push({
      id: "dem",
      name: "Terrain elevation",
      status: "failed",
      detail: "No DEM samples; using estimated street plane.",
    });
  }
  const hydrantN = access.filter((f) => f.kind === "hydrant").length;
  if (hydrantN) {
    attributes.push({
      field: "Fire hydrants",
      value: `${hydrantN} nearby`,
      from: "map",
      note: hydrantN === 1 ? "Nearest mapped hydrant on OpenStreetMap" : "Nearest mapped hydrants on OpenStreetMap",
    });
  }
  if (jpegSiteCues.length || geminiAerial.length || googleSat) {
    const fenceCues = [...geminiAerial, ...jpegSiteCues].filter((c) => c.kind === "fence").length;
    sources.push({
      id: "site-verify",
      name: "Site structure cross-check",
      status: "used",
      detail: [
        geminiAerial.length ? `${geminiAerial.length} Gemini satellite box(es)` : null,
        jpegSiteCues.length ? `${jpegSiteCues.length} Esri JPEG cue(s)` : null,
        fenceCues ? `${fenceCues} fence/hedge cue(s)` : null,
        googleSat ? "Google Static satellite" : null,
        "OpenStreetMap outlines",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  const yardFences = built.model.compound?.features.filter((f) => f.kind === "fence") ?? [];
  if (yardFences.length) {
    const fromAerial = yardFences.filter((f) => f.source === "aerial").length;
    const fromMap = yardFences.filter((f) => f.source === "map").length;
    const fromEst = yardFences.filter((f) => f.source === "estimated").length;
    attributes.push({
      field: "Yard barriers",
      value: `${yardFences.length} fence/hedge segment(s)`,
      from: fromMap ? "map" : fromAerial ? "photos" : "estimated",
      note: [
        fromMap ? `${fromMap} mapped` : null,
        fromAerial ? `${fromAerial} from aerial` : null,
        fromEst ? `${fromEst} estimated along lot line` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
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
      : indoorUsed > 0
        ? {
            field: "Interior",
            value: "OSM indoor + shell",
            from: "map",
            note: "OpenStreetMap Simple Indoor rooms inside the mapped outline. Not a full survey.",
          }
        : {
            field: "Interior",
            value: `Typical ${planWord} layout`,
            from: "estimated",
            note: "A common room plan inside the real outline. Not a measured scan.",
          },
  );
  sources.push(
    verified
      ? { id: "layout", name: "Verified interior", status: "used", detail: `Real room layout from: ${verified.interior?.source}.` }
      : {
          id: "layout",
          name: "Interior layout",
          status: "used",
          detail:
            indoorUsed > 0
              ? `OSM Simple Indoor (${indoorUsed} rooms) overlaid on the estimated shell.`
              : `Typical ${planWord} room plan drawn inside the mapped outline. Not a measured scan.`,
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
    images: [
      ...(aerial ? [{ label: "Aerial view · Esri World Imagery", url: `data:${aerial.mime};base64,${aerial.base64}` }] : []),
      ...streetView.shots.slice(0, 2).map((s) => ({
        label: s.label,
        url: `data:${s.image.mime};base64,${s.image.base64}`,
      })),
    ],
    summary: {
      width: built.width, depth: built.depth, area: Math.round(footprint ? polygonArea(footprint) : built.width * built.depth), facing: built.facing, stories, streetDir,
      nearby: (() => {
        const byId = new Map<number, string>();
        for (const n of osm?.nearby ?? []) {
          if (n.id != null && n.label) byId.set(n.id, n.label);
        }
        // Prefer addresses already on rendered neighbor shells (housenumber + street from OSM).
        for (const f of built.model.compound?.features ?? []) {
          if (f.kind !== "neighbor") continue;
          const m = /^neighbor-(\d+)$/.exec(f.id);
          if (!m) continue;
          const label = f.label?.trim();
          if (!label || /^neighbor$/i.test(label) || /^building\s+\d+$/i.test(label)) continue;
          byId.set(Number(m[1]), label);
        }
        return [...byId.entries()].map(([id, label]) => ({ id, label }));
      })(),
      match: osm?.chosenBy === "nearest" || osm?.chosenBy === "in-view-direction" ? "nearest" : osm?.chosenBy === "contains-point" ? "point" : "address",
    },
    createdAt: new Date().toISOString(),
  };
  // Don't save scans where the map server was down; the next try should get the real outline.
  if (osm) await store.put(result);
  emit({ type: "result", result, cached: false });
}
