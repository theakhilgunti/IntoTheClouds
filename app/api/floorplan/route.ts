import { BuildingModel, type Point } from "@/packages/schema/building-model";
import { applyFloorPlan, readFloorPlan } from "@/lib/floorplan";
import { geminiAvailable } from "@/lib/vision";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/floorplan (multipart): file (image), model (BuildingModel JSON), level (int), streetDir (JSON [x,y], optional).
 * Reads the plan with Gemini and returns { ok: true, model, notes } with the floor filled in,
 * or { ok: false, reasons } explaining why the plan can't be used. Never guesses.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, reasons: ["Expected form data."] }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return Response.json({ ok: false, reasons: ["No image was uploaded."] }, { status: 400 });
  if (file.size > 4_000_000) return Response.json({ ok: false, reasons: ["The image is too large (limit 4 MB)."] }, { status: 400 });
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    return Response.json({ ok: false, reasons: ["Use a JPEG, PNG or WebP image of the floor plan."] }, { status: 400 });
  }
  const level = Number(form.get("level"));
  if (!Number.isInteger(level) || level < -2 || level > 4) return Response.json({ ok: false, reasons: ["Unknown floor level."] }, { status: 400 });

  let model;
  try {
    const parsed = BuildingModel.safeParse(JSON.parse(String(form.get("model"))));
    if (!parsed.success) throw new Error("bad model");
    model = parsed.data;
  } catch {
    return Response.json({ ok: false, reasons: ["The building model sent with the plan is invalid."] }, { status: 400 });
  }
  let streetDir: Point | null = null;
  try {
    const sd = JSON.parse(String(form.get("streetDir") ?? "null"));
    if (Array.isArray(sd) && sd.length === 2 && sd.every((n) => typeof n === "number")) streetDir = sd as Point;
  } catch {
    /* optional */
  }
  if (!geminiAvailable()) return Response.json({ ok: false, reasons: ["Floor plan reading isn't configured on this server (no Gemini key)."] });

  const levelName = model.floors.find((f) => f.level === level)?.name ?? (level < 0 ? "basement" : `level ${level + 1}`);
  try {
    const plan = await readFloorPlan({ base64: Buffer.from(await file.arrayBuffer()).toString("base64"), mime: file.type as "image/jpeg" | "image/png" | "image/webp" }, levelName);
    const out = applyFloorPlan(model, plan, level, streetDir);
    return Response.json(out);
  } catch (e) {
    console.error("floorplan failed", e);
    return Response.json({ ok: false, reasons: ["Reading the plan failed or timed out. Try a clearer or smaller image."] });
  }
}
