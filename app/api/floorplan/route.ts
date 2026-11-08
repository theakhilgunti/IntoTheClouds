import { BuildingModel, type Point } from "@/packages/schema/building-model";
import { applyFloorPlan, readFloorPlan, type PlanRead } from "@/lib/floorplan";
import { looksLikeCubiCasaSvg, readCubiCasaSvg } from "@/lib/cubicasa-svg";
import { geminiAvailable } from "@/lib/vision";

export const runtime = "nodejs";
export const maxDuration = 300;

const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
const SVG_TYPES = /^(image\/svg\+xml|text\/xml|application\/xml|text\/plain)$/;

/**
 * POST /api/floorplan (multipart): file (image or CubiCasa SVG), model (BuildingModel JSON),
 * level (int), streetDir (JSON [x,y], optional).
 *
 * Prefer CubiCasa5K / CubiCasa SVG when present (vector rooms, no AI invent).
 * Otherwise Gemini reads a raster floor-plan photo. Returns { ok, model, notes } or { ok: false, reasons }.
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

  const name = (file.name || "").toLowerCase();
  const isSvg = name.endsWith(".svg") || file.type === "image/svg+xml" || (SVG_TYPES.test(file.type) && !IMAGE_TYPES.test(file.type));

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

  // CubiCasa / CubiCasa5K SVG path — verified vector rooms aligned to the mapped outline.
  if (isSvg) {
    const text = await file.text();
    if (!looksLikeCubiCasaSvg(text) && !/<svg[\s>]/i.test(text)) {
      return Response.json({
        ok: false,
        reasons: ["Upload a CubiCasa / CubiCasa5K SVG (groups with class=\"Space …\") or a JPEG/PNG/WebP photo of the plan."],
      });
    }
    try {
      const plan = readCubiCasaSvg(text) as PlanRead;
      const out = applyFloorPlan(model, plan, level, streetDir, {
        sourceLabel: "CubiCasa / CubiCasa5K SVG floor plan",
      });
      return Response.json(out);
    } catch (e) {
      console.error("cubicasa svg failed", e);
      return Response.json({ ok: false, reasons: ["Could not parse that CubiCasa SVG. Check it has Space room polygons."] });
    }
  }

  if (!IMAGE_TYPES.test(file.type)) {
    return Response.json({
      ok: false,
      reasons: ["Use a JPEG, PNG or WebP photo of the floor plan, or a CubiCasa / CubiCasa5K SVG."],
    }, { status: 400 });
  }
  if (!geminiAvailable()) {
    return Response.json({
      ok: false,
      reasons: ["Floor plan photo reading isn't configured (no Gemini key). Upload a CubiCasa SVG instead, or set GEMINI_API_KEY."],
    });
  }

  const levelName = model.floors.find((f) => f.level === level)?.name ?? (level < 0 ? "basement" : `level ${level + 1}`);
  try {
    const plan = await readFloorPlan(
      { base64: Buffer.from(await file.arrayBuffer()).toString("base64"), mime: file.type as "image/jpeg" | "image/png" | "image/webp" },
      levelName,
    );
    const out = applyFloorPlan(model, plan, level, streetDir, {
      sourceLabel: "uploaded floor plan, read by AI",
    });
    return Response.json(out);
  } catch (e) {
    console.error("floorplan failed", e);
    return Response.json({ ok: false, reasons: ["Reading the plan failed or timed out. Try a clearer or smaller image, or a CubiCasa SVG."] });
  }
}
