/**
 * BuildingModel — the shared contract between every CloudScan data source
 * (photo match, address lookup, WiFi mapping, manual upload) and the 3D viewer.
 *
 * Coordinates are meters in a local frame: x = east, y = north, origin at the
 * footprint's centroid. Heights/elevations are meters above ground floor.
 *
 * The WiFi team: produce JSON that passes `BuildingModel.parse()` (or the
 * exported JSON Schema in building-model.schema.json) and POST it to /api/models.
 */
import { z } from "zod";

export const Point = z.tuple([z.number(), z.number()]).describe("[x, y] in meters");
export type Point = z.infer<typeof Point>;

export const Polygon = z.array(Point).min(3).describe("Closed ring, no repeated last point");

export const RoomType = z.enum([
  "living",
  "kitchen",
  "dining",
  "bedroom",
  "bathroom",
  "hallway",
  "stair",
  "garage",
  "utility",
  "closet",
  "office",
  "basement",
  "other",
]);

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  type: RoomType,
  polygon: Polygon,
});

export const Wall = z.object({
  id: z.string(),
  a: Point,
  b: Point,
  thickness: z.number().positive().default(0.15),
  exterior: z.boolean().default(false),
});

export const Door = z.object({
  id: z.string(),
  wallId: z.string(),
  t: z.number().min(0).max(1).describe("Position of door center along the wall, 0 = a, 1 = b"),
  width: z.number().positive().default(0.9),
  exit: z.boolean().default(false).describe("True if it leads outside"),
});

export const Stairs = z.object({
  id: z.string(),
  polygon: Polygon,
  toLevel: z.number().int(),
});

export const Floor = z.object({
  level: z.number().int().describe("-1 basement, 0 ground, 1 second floor, ..."),
  name: z.string(),
  elevation: z.number(),
  height: z.number().positive().default(2.7),
  rooms: z.array(Room).default([]),
  walls: z.array(Wall).default([]),
  doors: z.array(Door).default([]),
  stairs: z.array(Stairs).default([]),
});

export const MarkerType = z.enum(["fire", "victim", "gas", "shutoff", "hazard", "entry"]);

export const Marker = z.object({
  id: z.string(),
  type: MarkerType,
  floor: z.number().int(),
  pos: Point,
  note: z.string().default(""),
  createdAt: z.string().describe("ISO timestamp"),
});

export const RoofShape = z.enum(["gable", "hip", "flat", "gambrel", "mansard", "other"]);

/** Optional exterior roof, drawn on top of the highest floor. Oriented rectangle in the model frame. */
export const Roof = z.object({
  shape: RoofShape,
  center: Point,
  width: z.number().positive(),
  depth: z.number().positive(),
  rotation: z.number().describe("Radians, counter-clockwise from +x (east)"),
  height: z.number().nonnegative().describe("Rise above the top floor's ceiling, meters"),
});

/**
 * How much we actually know about the inside. "verified" = rooms come from a real source (floor plan,
 * survey, WiFi scan). "unknown" = nothing measured the interior, so the model has no rooms and the
 * house needs a scan. We never draw guessed rooms.
 */
export const Interior = z.object({
  status: z.enum(["verified", "unknown"]),
  source: z.string().optional().describe("Where verified rooms came from, e.g. 'floor plan', 'wifi scan'"),
  reasons: z.array(z.string()).default([]).describe("Why the interior is unknown (empty when verified)"),
});

export const BuildingModel = z.object({
  id: z.string(),
  source: z.enum(["photo", "address", "wifi", "upload", "demo"]),
  confidence: z.number().min(0).max(1),
  address: z.string().default(""),
  lat: z.number(),
  lng: z.number(),
  footprint: Polygon,
  floors: z.array(Floor).min(1),
  markers: z.array(Marker).default([]),
  roof: Roof.optional(),
  interior: Interior.optional().describe("Absent on old scans and the demo house"),
});

export type Interior = z.infer<typeof Interior>;
export type RoofShape = z.infer<typeof RoofShape>;
export type Roof = z.infer<typeof Roof>;

export type RoomType = z.infer<typeof RoomType>;
export type Room = z.infer<typeof Room>;
export type Wall = z.infer<typeof Wall>;
export type Door = z.infer<typeof Door>;
export type Stairs = z.infer<typeof Stairs>;
export type Floor = z.infer<typeof Floor>;
export type MarkerType = z.infer<typeof MarkerType>;
export type Marker = z.infer<typeof Marker>;
export type BuildingModel = z.infer<typeof BuildingModel>;
