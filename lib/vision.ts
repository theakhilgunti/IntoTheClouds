/**
 * Gemini vision step: look at the user's photo and the aerial image and describe the house.
 * Uses the Gemini REST API (free tier key from Google AI Studio). Set GEMINI_API_KEY in .env.local.
 * GEMINI_MODEL overrides the model (default: the current Flash model alias).
 */
import { z } from "zod";
import type { Image } from "./imagery";

export const HouseFacts = z.object({
  stories: z.number().int().min(1).max(4),
  roof_shape: z.enum(["gable", "hip", "flat", "gambrel", "mansard", "other"]),
  /** Which way the ridge runs, as seen from the street. Prefer the aerial for this. */
  ridge_along: z.enum(["front_to_back", "side_to_side", "unknown"]).default("unknown"),
  garage: z.enum(["none", "attached_left", "attached_right", "detached", "unknown"]),
  basement: z.enum(["visible", "likely", "unlikely", "unknown"]),
  exterior_material: z.string(),
  style: z.string(),
  photo_matches_aerial: z.enum(["yes", "no", "unsure", "no_photo"]),
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
    confidence: { type: "NUMBER", description: "0 to 1, how sure you are overall" },
    observations: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Up to 6 short factual observations that support your answers",
    },
  },
  required: [
    "stories", "roof_shape", "ridge_along", "garage", "basement", "exterior_material", "style",
    "photo_matches_aerial", "confidence", "observations",
  ],
};

export function geminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

export function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-flash-latest";
}

export async function describeHouse(opts: { photo: Image | null; aerial: Image | null; facts: string }): Promise<HouseFacts> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const parts: object[] = [];
  if (opts.photo) {
    parts.push({ text: "Image 1: a photo of the house, taken from the street by the user." });
    parts.push({ inlineData: { mimeType: opts.photo.mime, data: opts.photo.base64 } });
  }
  if (opts.aerial) {
    parts.push({
      text: `Image ${opts.photo ? 2 : 1}: aerial photo, north is up, the house in question is at the center.`,
    });
    parts.push({ inlineData: { mimeType: opts.aerial.mime, data: opts.aerial.base64 } });
  }
  parts.push({
    text:
      "You help firefighters understand a house before they go in. Describe the house at the center of the " +
      "aerial image (and in the street photo, if given). Count floors above ground carefully: a dormer or attic " +
      "window does not count as a full floor. For roof_shape and ridge_along, prefer the aerial: a long dark " +
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
      signal: AbortSignal.timeout(30000),
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
  raw.stories = Math.min(4, Math.max(1, Math.round(raw.stories ?? 2)));
  raw.confidence = Math.min(1, Math.max(0, raw.confidence ?? 0.5));
  raw.observations = (raw.observations ?? []).slice(0, 6);
  if (!raw.ridge_along) raw.ridge_along = "unknown";
  return HouseFacts.parse(raw);
}

const SITE_KINDS = ["garage", "shed", "driveway", "patio", "pool", "trees"] as const;

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

/** Boxes around things next to the house in a north-up aerial photo. Empty when nothing is clear. */
export async function describeSite(aerial: Image): Promise<AerialBox[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "Aerial photo. North is up. The house is at the center. Do not box the house itself." },
            { inlineData: { mimeType: aerial.mime, data: aerial.base64 } },
            {
              text:
                "Mark only features you can actually see around that house: detached garage, shed, driveway, patio or deck, swimming pool, and a distinct clump of trees. " +
                "Coordinates are 0 to 1000. x grows to the right (east). y grows downward (south). Boxes should be tight. " +
                "If you are not sure a feature is there, leave it out. Do not mark fences. Return an empty list when the photo is unclear.",
            },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SITE_SCHEMA, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(30000),
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
