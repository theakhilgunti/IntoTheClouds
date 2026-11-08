/**
 * Floor plan reader. A person uploads a picture of ONE floor's plan (listing floor plan, permit drawing,
 * evacuation map). Gemini reads the rooms/doors it can SEE in the image; nothing is invented. Our code
 * then scales and aligns the plan to the real building outline and builds walls, doors and stairs.
 * If the image can't be read, or doesn't fit the building, we say why and change nothing.
 */
import { z } from "zod";
import { minAreaRect } from "./geo";
import { geminiModel } from "./vision";
import { summarizeInterior } from "./interior";
import type { Image } from "./imagery";
import type { BuildingModel, Door, Floor, Point, Room, Stairs, Wall } from "@/packages/schema/building-model";

const ROOM_TYPES = [
  "living", "kitchen", "dining", "bedroom", "bathroom", "hallway", "stair", "garage",
  "utility", "closet", "office", "basement", "other",
] as const;

export const PlanRead = z.object({
  readable: z.boolean(),
  problems: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  front_side: z.enum(["top", "bottom", "left", "right", "unknown"]),
  overall_width_m: z.number().min(0),
  overall_depth_m: z.number().min(0),
  rooms: z.array(
    z.object({
      name: z.string(),
      type: z.enum(ROOM_TYPES),
      box: z.array(z.number()).length(4),
    }),
  ),
  doors: z.array(z.object({ point: z.array(z.number()).length(2), exterior: z.boolean() })),
});
export type PlanRead = z.infer<typeof PlanRead>;

const BOX = { type: "ARRAY", items: { type: "NUMBER" }, minItems: 4, maxItems: 4 };
const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    readable: { type: "BOOLEAN", description: "False if this is not a floor plan, or too blurry/small to read reliably" },
    problems: { type: "ARRAY", items: { type: "STRING" }, description: "Why it is unreadable or uncertain. Empty if fine." },
    confidence: { type: "NUMBER", description: "0 to 1, how sure you are the rooms below match the drawing" },
    front_side: {
      type: "STRING",
      enum: ["top", "bottom", "left", "right", "unknown"],
      description: "Image edge the main/front entrance is on, only if drawn or labeled; otherwise unknown",
    },
    overall_width_m: { type: "NUMBER", description: "Whole building width (left-right) in meters if dimension labels allow, else 0" },
    overall_depth_m: { type: "NUMBER", description: "Whole building depth (top-bottom) in meters if dimension labels allow, else 0" },
    rooms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Label as drawn, e.g. 'Kitchen'" },
          type: { type: "STRING", enum: [...ROOM_TYPES] },
          box: { ...BOX, description: "[ymin, xmin, ymax, xmax] on a 0-1000 grid, origin top-left of the image" },
        },
        required: ["name", "type", "box"],
      },
    },
    doors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          point: { type: "ARRAY", items: { type: "NUMBER" }, minItems: 2, maxItems: 2, description: "[y, x] on the 0-1000 grid" },
          exterior: { type: "BOOLEAN", description: "True if the door leads outside" },
        },
        required: ["point", "exterior"],
      },
    },
  },
  required: ["readable", "problems", "confidence", "front_side", "overall_width_m", "overall_depth_m", "rooms", "doors"],
};

export async function readFloorPlan(image: Image, levelName: string): Promise<PlanRead> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const prompt =
    `This image should be the architectural floor plan of the ${levelName} of ONE house, used by firefighters. ` +
    "Report only what is drawn. Never invent rooms, doors or dimensions. " +
    "List every enclosed space (including hallways, closets, bathrooms, stairs and garages) as non-overlapping " +
    "rectangles on a 0-1000 grid with the origin at the image's top-left, as [ymin, xmin, ymax, xmax]. " +
    "Split L-shaped or irregular rooms into several rectangles with the same name. The rectangles together should " +
    "cover the whole drawn building and nothing outside it (ignore decks, yards, title blocks and legends). " +
    "List door openings you can see as [y, x] points. If the image is not a floor plan, shows more than one " +
    "floor, or is too small or blurry to read reliably, set readable to false and explain in problems.";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_PLAN_MODEL || geminiModel()}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: image.mime, data: image.base64 } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: PLAN_SCHEMA, temperature: 0 },
      }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text: string | undefined = j.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
  if (!text) throw new Error("Gemini returned no answer");
  return PlanRead.parse(JSON.parse(text));
}

// ---------------------------------------------------------------- geometry

type Box = { name: string; type: (typeof ROOM_TYPES)[number]; x0: number; y0: number; x1: number; y1: number };
const TOL = 28; // 2.8% of the plan: edges closer than this are the same wall (AI boxes sit slightly inside the drawn walls)
const FLOOR_NAMES: Record<number, string> = { [-1]: "Basement", 0: "1st Floor", 1: "2nd Floor", 2: "3rd Floor" };

function snapAxis(values: number[]): Map<number, number> {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const map = new Map<number, number>();
  let group: number[] = [];
  const flush = () => {
    if (!group.length) return;
    const mean = Math.round(group.reduce((s, v) => s + v, 0) / group.length);
    group.forEach((v) => map.set(v, mean));
    group = [];
  };
  for (const v of sorted) {
    if (group.length && v - group[0] > TOL) flush();
    group.push(v);
  }
  flush();
  return map;
}

type Seg = { horiz: boolean; c: number; from: number; to: number; ext: boolean };

export type ApplyResult =
  | { ok: true; model: BuildingModel; notes: string[]; roomCount: number }
  | { ok: false; reasons: string[] };

export type ApplyFloorPlanOpts = {
  /** Provenance written into interior.source (e.g. CubiCasa SVG vs Gemini image). */
  sourceLabel?: string;
};

/** Put one floor's read plan onto the model. Returns the new model, or why it can't be trusted. */
export function applyFloorPlan(
  model: BuildingModel,
  plan: PlanRead,
  level: number,
  streetDir: Point | null,
  opts: ApplyFloorPlanOpts = {},
): ApplyResult {
  const levelName = FLOOR_NAMES[level] ?? `Level ${level}`;
  if (!plan.readable) {
    return { ok: false, reasons: ["This image can't be read as a floor plan.", ...plan.problems] };
  }
  if (plan.confidence < 0.5) {
    return { ok: false, reasons: [`The plan was read with low confidence (${Math.round(plan.confidence * 100)}%), so it was not used.`, ...plan.problems] };
  }

  let boxes: Box[] = plan.rooms
    .map((r) => {
      const [ya, xa, yb, xb] = r.box.map((n) => Math.min(1000, Math.max(0, n)));
      return { name: r.name, type: r.type, x0: Math.min(xa, xb), y0: Math.min(ya, yb), x1: Math.max(xa, xb), y1: Math.max(ya, yb) };
    })
    .filter((b) => b.x1 - b.x0 >= 15 && b.y1 - b.y0 >= 15);
  if (boxes.length < 3) {
    return { ok: false, reasons: [`Only ${boxes.length} room(s) could be read from this plan, which isn't enough to build a floor.`, ...plan.problems] };
  }

  const sx = snapAxis(boxes.flatMap((b) => [b.x0, b.x1]));
  const sy = snapAxis(boxes.flatMap((b) => [b.y0, b.y1]));
  boxes = boxes
    .map((b) => ({ ...b, x0: sx.get(b.x0)!, x1: sx.get(b.x1)!, y0: sy.get(b.y0)!, y1: sy.get(b.y1)! }))
    .filter((b) => b.x1 > b.x0 && b.y1 > b.y0);

  const minX = Math.min(...boxes.map((b) => b.x0)), maxX = Math.max(...boxes.map((b) => b.x1));
  const minY = Math.min(...boxes.map((b) => b.y0)), maxY = Math.max(...boxes.map((b) => b.y1));
  const Wp = maxX - minX, Dp = maxY - minY;
  if (Wp < 200 || Dp < 200) return { ok: false, reasons: ["The rooms read from the plan cover too small an area to be a whole floor."] };

  // Fit the plan to the real outline: choose the rotation whose proportions match best, then use the front side.
  const rect = minAreaRect(model.footprint);
  const u = rect.u, v = rect.v;
  const neg = (p: Point): Point => [-p[0], -p[1]];
  const rot90 = (p: Point): Point => [-p[1], p[0]];
  const candidates: { a: Point; Wm: number; Dm: number }[] = [
    { a: u, Wm: rect.wU, Dm: rect.wV },
    { a: neg(u), Wm: rect.wU, Dm: rect.wV },
    { a: v, Wm: rect.wV, Dm: rect.wU },
    { a: neg(v), Wm: rect.wV, Dm: rect.wU },
  ];
  const mismatch = (c: { Wm: number; Dm: number }) => {
    const r = Wp / Dp / (c.Wm / c.Dm);
    return Math.max(r, 1 / r);
  };
  const bestParity = mismatch(candidates[0]) <= mismatch(candidates[2]) ? [candidates[0], candidates[1]] : [candidates[2], candidates[3]];
  const worst = mismatch(bestParity[0]);
  if (worst > 1.3) {
    return {
      ok: false,
      reasons: [
        `The plan's shape (${(Wp / Dp).toFixed(2)} : 1) doesn't match this building's outline (${(Math.max(rect.wU, rect.wV) / Math.min(rect.wU, rect.wV)).toFixed(2)} : 1). It may be the wrong plan, the wrong floor, or the outline may be a different building.`,
      ],
    };
  }
  if (plan.overall_width_m > 0 && plan.overall_depth_m > 0) {
    const ratio = (plan.overall_width_m * plan.overall_depth_m) / (rect.wU * rect.wV);
    if (ratio < 0.6 || ratio > 1.6) {
      return {
        ok: false,
        reasons: [
          `The plan is labeled about ${plan.overall_width_m.toFixed(1)} × ${plan.overall_depth_m.toFixed(1)} m but the mapped building is ${rect.wU.toFixed(1)} × ${rect.wV.toFixed(1)} m. It may be the wrong building.`,
        ],
      };
    }
  }

  const notes: string[] = [];
  const frontNormals: Record<string, Point> = { top: [0, 1], bottom: [0, -1], left: [-1, 0], right: [1, 0] };
  // Every rotation whose proportions fit the outline is allowed; among them, prefer the one whose entrance faces the street.
  const fits = candidates.filter((c) => mismatch(c) <= 1.3);
  const byFit = [...fits].sort((p, q) => mismatch(p) - mismatch(q));
  const fn = frontNormals[plan.front_side];
  let chosen = byFit[0];
  if (fn && streetDir) {
    const facing = (c: { a: Point }) => {
      const bb = rot90(c.a);
      const n: Point = [fn[0] * c.a[0] + fn[1] * bb[0], fn[0] * c.a[1] + fn[1] * bb[1]];
      return n[0] * streetDir[0] + n[1] * streetDir[1];
    };
    chosen = [...fits].sort((p, q) => facing(q) - facing(p) || mismatch(p) - mismatch(q))[0];
    if (facing(chosen) < 0.5) {
      notes.push("The entrance on the plan doesn't face the street the map shows. Check that the plan is placed the right way round.");
    }
  } else {
    notes.push("Couldn't tell which side of the plan is the front, so the plan may be turned 180°. Check the entrance position.");
  }
  if (mismatch(chosen) > 1.12) notes.push("The plan's proportions differ from the mapped outline, so it was stretched to fit.");
  const a = chosen.a, b = rot90(chosen.a);
  const T = (px: number, py: number): Point => {
    const qx = (px - minX) / Wp - 0.5;
    const qy = 0.5 - (py - minY) / Dp;
    return [
      Math.round((rect.center[0] + qx * chosen.Wm * a[0] + qy * chosen.Dm * b[0]) * 1e4) / 1e4,
      Math.round((rect.center[1] + qx * chosen.Wm * a[1] + qy * chosen.Dm * b[1]) * 1e4) / 1e4,
    ];
  };

  // Walls: every boundary between two different rooms, or between a room and outside.
  const roomAt = (px: number, py: number) => boxes.findIndex((r) => px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1);
  const xs = [...new Set(boxes.flatMap((r) => [r.x0, r.x1]))].sort((p, q) => p - q);
  const ys = [...new Set(boxes.flatMap((r) => [r.y0, r.y1]))].sort((p, q) => p - q);
  const segs: Seg[] = [];
  const E = 0.25;
  for (const y of ys) {
    for (let i = 0; i < xs.length - 1; i++) {
      const xm = (xs[i] + xs[i + 1]) / 2;
      const up = roomAt(xm, y - E), down = roomAt(xm, y + E);
      if (up !== down) segs.push({ horiz: true, c: y, from: xs[i], to: xs[i + 1], ext: up < 0 || down < 0 });
    }
  }
  for (const x of xs) {
    for (let i = 0; i < ys.length - 1; i++) {
      const ym = (ys[i] + ys[i + 1]) / 2;
      const l = roomAt(x - E, ym), r = roomAt(x + E, ym);
      if (l !== r) segs.push({ horiz: false, c: x, from: ys[i], to: ys[i + 1], ext: l < 0 || r < 0 });
    }
  }
  const merged: Seg[] = [];
  for (const s of segs.sort((p, q) => Number(q.horiz) - Number(p.horiz) || p.c - q.c || p.from - q.from)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.horiz === s.horiz && prev.c === s.c && prev.ext === s.ext && prev.to === s.from) prev.to = s.to;
    else merged.push({ ...s });
  }
  const prefix = level < 0 ? "b-" : `f${level}-`;
  const walls: Wall[] = merged.map((s, i) => ({
    id: `${prefix}w${i}`,
    a: s.horiz ? T(s.from, s.c) : T(s.c, s.from),
    b: s.horiz ? T(s.to, s.c) : T(s.c, s.to),
    thickness: s.ext ? 0.25 : 0.12,
    exterior: s.ext,
  }));

  // Doors: each drawn door goes on the nearest wall.
  const doors: Door[] = [];
  for (const d of plan.doors) {
    const py = Math.min(1000, Math.max(0, d.point[0])), px = Math.min(1000, Math.max(0, d.point[1]));
    let best = -1, bestD = Infinity, bestT = 0.5;
    merged.forEach((s, i) => {
      const along = s.horiz ? px : py, across = s.horiz ? py : px;
      const t = Math.min(1, Math.max(0, (along - s.from) / (s.to - s.from)));
      const clamped = s.from + t * (s.to - s.from);
      const dist = Math.hypot(along - clamped, across - s.c);
      if (dist < bestD) { bestD = dist; best = i; bestT = t; }
    });
    if (best < 0 || bestD > 45) continue;
    const w = walls[best];
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.6) continue;
    doors.push({ id: `${prefix}d${doors.length}`, wallId: w.id, t: Math.min(0.9, Math.max(0.1, bestT)), width: Math.min(d.exterior ? 1 : 0.85, len - 0.2), exit: d.exterior });
  }
  if (!doors.length) notes.push("No door openings could be read from the plan, so doors are not shown.");

  const rooms: Room[] = boxes.map((r, i) => ({
    id: `${prefix}r${i}`,
    name: r.name || r.type,
    type: r.type,
    polygon: [T(r.x0, r.y0), T(r.x1, r.y0), T(r.x1, r.y1), T(r.x0, r.y1)],
  }));
  const up = model.floors.some((f) => f.level === level + 1);
  const stairs: Stairs[] = boxes
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.type === "stair")
    .map(({ i }) => ({ id: `${prefix}s${i}`, polygon: rooms[i].polygon, toLevel: up ? level + 1 : level - 1 }));

  const existing = model.floors.find((f) => f.level === level);
  const floor: Floor = {
    level,
    name: existing?.name ?? levelName,
    elevation: existing?.elevation ?? (level < 0 ? -2.5 : level * 2.8),
    height: existing?.height ?? (level < 0 ? 2.5 : 2.8),
    rooms, walls, doors, stairs,
  };
  const floors = [...model.floors.filter((f) => f.level !== level), floor].sort((p, q) => p.level - q.level);

  const sourceLabel = opts.sourceLabel ?? "uploaded floor plan, read by AI";
  const interior = summarizeInterior(
    floors,
    {
      status: model.interior?.status ?? "estimated",
      source: model.interior?.source,
      reasons: model.interior?.reasons ?? [],
      knownLevels: [...new Set([...(model.interior?.knownLevels ?? []), level])],
      notes: model.interior?.notes ?? [],
    },
    notes,
    sourceLabel,
  );
  return { ok: true, model: { ...model, floors, interior }, notes, roomCount: boxes.length };
}
