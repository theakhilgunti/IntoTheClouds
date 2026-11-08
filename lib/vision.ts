/**
 * Gemini vision step: look at the user's photo and the aerial image and describe the house.
 * Uses the Gemini REST API (free tier key from Google AI Studio). Set GEMINI_API_KEY in .env.local.
 * GEMINI_MODEL overrides the model (default: the current Flash model alias).
 */
import { z } from "zod";
import type { Image } from "./imagery";

export const HouseFacts = z.object({
  stories: z.number().int().min(1).max(6),
  roof_shape: z.enum(["gable", "hip", "flat", "gambrel", "mansard", "other"]),
  /** Which way the ridge runs, as seen from the street. Prefer the aerial for this. */
  ridge_along: z.enum(["front_to_back", "side_to_side", "unknown"]).default("unknown"),
  garage: z.enum(["none", "attached_left", "attached_right", "detached", "unknown"]),
  basement: z.enum(["visible", "likely", "unlikely", "unknown"]),
  exterior_material: z.string(),
  style: z.string(),
  photo_matches_aerial: z.enum(["yes", "no", "unsure", "no_photo"]),
  /** Front door / main entry as seen from the street. */
  entry: z.enum(["center", "left", "right", "unknown"]).default("unknown"),
  /**
   * Front door position along the street facade (0 = left edge, 1 = right edge)
   * as seen standing on the street looking at the house.
   */
  front_door_t: z.number().min(0).max(1).optional(),
  /** Visible front-facing window openings on the main story (approx). */
  front_windows: z.number().int().min(0).max(12).optional(),
  /** Pedestrian side entry toward a driveway / flank. */
  side_entry: z.enum(["left", "right", "none", "unknown"]).default("unknown"),
  /** Covered porch or stoop visible on the street facade. */
  porch: z.enum(["yes", "no", "unknown"]).default("unknown"),
  confidence: z.number().min(0).max(1),
  observations: z.array(z.string()).max(6),
});
export type HouseFacts = z.infer<typeof HouseFacts>;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    stories: { type: "INTEGER", description: "Floors above ground, not counting basement or attic" },
    roof_shape: { type: "STRING", enum: ["gable", "hip", "flat", "gambrel", "mansard", "other"] },
    ridge_along: {
      type: "STRING",
      enum: ["front_to_back", "side_to_side", "unknown"],
      description:
        "From the aerial: front_to_back = ridge runs from the street face toward the backyard; side_to_side = ridge runs left-right parallel to the street",
    },
    garage: {
      type: "STRING",
      enum: ["none", "attached_left", "attached_right", "detached", "unknown"],
      description: "Left/right as seen standing on the street looking at the front of the house",
    },
    basement: { type: "STRING", enum: ["visible", "likely", "unlikely", "unknown"] },
    exterior_material: { type: "STRING", description: "e.g. vinyl siding, brick, wood clapboard" },
    style: { type: "STRING", description: "e.g. colonial, ranch, cape cod, row house, victorian" },
    photo_matches_aerial: { type: "STRING", enum: ["yes", "no", "unsure", "no_photo"] },
    entry: {
      type: "STRING",
      enum: ["center", "left", "right", "unknown"],
      description: "Main front entry as seen from the street looking at the facade",
    },
    front_door_t: {
      type: "NUMBER",
      description:
        "0 to 1 position of the main front door along the street facade (0=left edge, 1=right edge as seen from the street). Prefer Street View.",
    },
    front_windows: {
      type: "INTEGER",
      description:
        "Approximate count of front-facing window openings on the main above-ground story (not counting the door or garage door). Prefer Street View.",
    },
    side_entry: {
      type: "STRING",
      enum: ["left", "right", "none", "unknown"],
      description: "Pedestrian side door toward the driveway / flank, as seen from the street",
    },
    porch: {
      type: "STRING",
      enum: ["yes", "no", "unknown"],
      description: "Whether a porch or stoop is visible on the street facade",
    },
    confidence: { type: "NUMBER", description: "0 to 1, how sure you are overall" },
    observations: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Up to 6 short factual observations that support your answers",
    },
  },
  required: [
    "stories", "roof_shape", "ridge_along", "garage", "basement", "exterior_material", "style",
    "photo_matches_aerial", "entry", "side_entry", "porch", "confidence", "observations",
  ],
};

export function geminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

export function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-flash-latest";
}

export async function describeHouse(opts: {
  photo: Image | null;
  aerial: Image | null;
  /** Google Street View facade shots (front + flanks) when available. */
  streetViews?: Image[] | null;
  facts: string;
}): Promise<HouseFacts> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const parts: object[] = [];
  let n = 0;
  if (opts.photo) {
    n += 1;
    parts.push({ text: `Image ${n}: a photo of the house, taken from the street by the user.` });
    parts.push({ inlineData: { mimeType: opts.photo.mime, data: opts.photo.base64 } });
  }
  if (opts.aerial) {
    n += 1;
    parts.push({
      text: `Image ${n}: aerial photo, north is up, the house in question is at the center.`,
    });
    parts.push({ inlineData: { mimeType: opts.aerial.mime, data: opts.aerial.base64 } });
  }
  const street = (opts.streetViews ?? []).slice(0, 3);
  street.forEach((img, i) => {
    n += 1;
    const where = i === 0 ? "front facade" : i === 1 ? "front-left flank" : "front-right flank";
    parts.push({
      text:
        `Image ${n}: Google Street View of the ${where}, looking at the house from the road. ` +
        "Use this for stories, garage side, entry, front_door_t, front_windows, side_entry, porch, basement windows, and exterior material. " +
        "Left/right are as seen in this street view.",
    });
    parts.push({ inlineData: { mimeType: img.mime, data: img.base64 } });
  });
  parts.push({
    text:
      "You help firefighters understand a house before they go in. Describe the house at the center of the " +
      "aerial image (and in the street / Street View photos, if given). Count floors above ground carefully: a dormer or attic " +
      "window does not count as a full floor. Prefer Street View for stories, garage left/right, entry, front_door_t, " +
      "front_windows, side_entry, porch, and basement windows when those shots are present. " +
      "front_door_t is 0 at the left edge of the street facade and 1 at the right edge as you face the house. " +
      "front_windows counts openings on the main story facing the street (exclude the door and garage door). " +
      "For roof_shape and ridge_along, prefer the aerial: a long dark " +
      "rectangle with a center seam is usually a gable; a rectangle that tapers on all four sides is a hip; a " +
      "featureless pad is flat. Only report what the images support; use \"unknown\" when you cannot tell. Map " +
      "data we already have:\n" + opts.facts,
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(45000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const text: string | undefined = j.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
  if (!text) throw new Error("Gemini returned no answer");
  const raw = JSON.parse(text);
  raw.stories = Math.min(6, Math.max(1, Math.round(raw.stories ?? 2)));
  raw.confidence = Math.min(1, Math.max(0, raw.confidence ?? 0.5));
  raw.observations = (raw.observations ?? []).slice(0, 6);
  if (!raw.ridge_along) raw.ridge_along = "unknown";
  if (!raw.entry) raw.entry = "unknown";
  if (!raw.side_entry) raw.side_entry = "unknown";
  if (!raw.porch) raw.porch = "unknown";
  if (raw.front_door_t != null) {
    const t = Number(raw.front_door_t);
    raw.front_door_t = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : undefined;
  }
  if (raw.front_windows != null) {
    const n = Math.round(Number(raw.front_windows));
    raw.front_windows = Number.isFinite(n) ? Math.min(12, Math.max(0, n)) : undefined;
  }
  return HouseFacts.parse(raw);
}

const SITE_KINDS = ["garage", "shed", "driveway", "patio", "pool", "trees", "fence"] as const;

export const AerialBox = z.object({
  kind: z.enum(SITE_KINDS),
  label: z.string().max(40).default(""),
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
export type AerialBox = z.infer<typeof AerialBox>;

const SITE_SCHEMA = {
  type: "OBJECT",
  properties: {
    features: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: [...SITE_KINDS] },
          label: { type: "STRING", description: "Short name, e.g. Garage or Driveway" },
          x0: { type: "NUMBER", description: "Left edge, 0 to 1000" },
          y0: { type: "NUMBER", description: "Top edge, 0 to 1000" },
          x1: { type: "NUMBER", description: "Right edge, 0 to 1000" },
          y1: { type: "NUMBER", description: "Bottom edge, 0 to 1000" },
        },
        required: ["kind", "label", "x0", "y0", "x1", "y1"],
      },
    },
  },
  required: ["features"],
};

/**
 * Boxes around things next to the house in north-up satellite imagery.
 * Pass a second shot (e.g. Google Maps Static) when available so Gemini can cross-check.
 */
export async function describeSite(aerial: Image, crossCheck?: Image | null): Promise<AerialBox[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const parts: Array<Record<string, unknown>> = [
    {
      text:
        "Satellite / aerial view like Google Maps. North is up. The house is at the center. Do not box the house itself.",
    },
    { inlineData: { mimeType: aerial.mime, data: aerial.base64 } },
  ];
  if (crossCheck) {
    parts.push({
      text: "Second satellite image of the same place (Google Maps or alternate source). Only mark features visible in BOTH images when they disagree.",
    });
    parts.push({ inlineData: { mimeType: crossCheck.mime, data: crossCheck.base64 } });
  }
  parts.push({
    text:
      "Cross-verify structures and yard obstacles around that house: detached garage, shed, driveway, patio or deck, swimming pool, " +
      "distinct tree clumps, and fence or hedge lines (thin boxes along backyard and side-lot barriers). " +
      "Prefer features confirmed by paving tone, shadow, roof rectangles, or dark/green linear ribbons — not guesses. " +
      "Coordinates are 0 to 1000. x grows to the right (east). y grows downward (south). Boxes should be tight. " +
      "For fences/hedges, draw elongated boxes along the barrier (not the street curb). " +
      "If you are not sure a feature is there, leave it out. Do not mark the street itself. Return an empty list when the photo is unclear.",
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SITE_SCHEMA, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(35000),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const j = await res.json();
  const text: string | undefined = j.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
  if (!text) return [];
  const raw = JSON.parse(text);
  const list = Array.isArray(raw?.features) ? raw.features : [];
  const boxes: AerialBox[] = [];
  for (const item of list) {
    const parsed = AerialBox.safeParse({
      ...item,
      label: String(item?.label ?? "").slice(0, 40),
      x0: Number(item?.x0),
      y0: Number(item?.y0),
      x1: Number(item?.x1),
      y1: Number(item?.y1),
    });
    if (parsed.success) boxes.push(parsed.data);
  }
  return boxes.slice(0, 8);
}
