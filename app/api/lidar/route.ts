import { runScan, ScanError } from "@/lib/scan/scan";
import type { ScanResult } from "@/lib/scan/sources";
import { store } from "@/lib/scan/store";
import { applyRoomPlan } from "@/lib/model/roomplan";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/lidar (JSON): { address, scan, frame?, level?, capturedAt?, capturedBy? }
 *   scan  = JSON of an Apple RoomPlan CapturedRoom or CapturedStructure ({ rooms: [...] } also works).
 *   frame = "north" if the scan used ARKit gravityAndHeading (exact rotation), else "arbitrary" (default).
 * Finds the real building for the address, places the measured rooms inside it, and saves the result,
 * so typing that address later shows the scanned interior. Refuses scans that don't fit the building.
 *
 * Auth: send header `x-upload-key` equal to LIDAR_UPLOAD_KEY. If the variable is unset, uploads are
 * only accepted outside production, so nobody can overwrite a verified interior on the live site.
 */
export async function POST(req: Request) {
  const key = process.env.LIDAR_UPLOAD_KEY;
  if (key ? req.headers.get("x-upload-key") !== key : process.env.NODE_ENV === "production") {
    return Response.json({ ok: false, reasons: ["Not authorized to upload scans."] }, { status: 401 });
  }
  let body: { address?: unknown; scan?: unknown; frame?: unknown; level?: unknown; capturedAt?: unknown; capturedBy?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reasons: ["Expected a JSON body."] }, { status: 400 });
  }
  if (typeof body.address !== "string" || !body.address.trim() || !body.scan) {
    return Response.json({ ok: false, reasons: ["Send { address, scan }."] }, { status: 400 });
  }

  let result: ScanResult | null = null;
  try {
    await runScan({ address: body.address.slice(0, 300) }, (e) => {
      if (e.type === "result") result = e.result;
    });
  } catch (e) {
    const msg = e instanceof ScanError ? e.message : "Couldn't look up that address.";
    return Response.json({ ok: false, reasons: [msg] }, { status: 422 });
  }
  const base = result as ScanResult | null;
  if (!base) return Response.json({ ok: false, reasons: ["Couldn't look up that address."] }, { status: 422 });
  if (base.model.id.startsWith("pt-")) {
    return Response.json({ ok: false, reasons: ["No building outline is mapped at this address, so a scan can't be placed. Nothing was saved."] }, { status: 422 });
  }

  const out = applyRoomPlan(base.model, body.scan, {
    frame: body.frame === "north" ? "north" : "arbitrary",
    level: Number.isInteger(body.level) ? (body.level as number) : 0,
    capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString(),
    capturedBy: typeof body.capturedBy === "string" ? body.capturedBy.slice(0, 80) : undefined,
  });
  if (!out.ok) return Response.json(out, { status: 422 });

  const saved: ScanResult = {
    ...base,
    model: out.model,
    warnings: [...base.warnings, ...out.notes],
    attributes: [
      ...base.attributes.filter((a) => a.field !== "Interior"),
      { field: "Interior", value: out.model.interior?.status === "verified" ? "Verified" : "Partly known", from: "map", note: `Source: ${out.model.interior?.source}` },
    ],
  };
  await store.put(saved);
  return Response.json({ ok: true, id: out.model.id, rooms: out.roomCount, notes: out.notes, url: `/model/${out.model.id}` });
}
