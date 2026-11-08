import { runScan, ScanError, type ScanInput } from "@/lib/scan";
import type { ScanEvent } from "@/lib/sources";

export const runtime = "nodejs";
export const maxDuration = 300;

const num = (v: FormDataEntryValue | null) => {
  if (typeof v !== "string" || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * POST /api/scan (multipart form): address | lat+lng[+heading], optional photo (JPEG), optional rescan=1.
 * Streams newline-delimited JSON ScanEvents: progress steps, then one result or error.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected form data" }, { status: 400 });
  }
  const photo = form.get("photo");
  const input: ScanInput = {
    address: typeof form.get("address") === "string" ? (form.get("address") as string).slice(0, 300) : undefined,
    lat: num(form.get("lat")),
    lng: num(form.get("lng")),
    heading: num(form.get("heading")) ?? null,
    rescan: form.get("rescan") === "1",
    wayId: num(form.get("wayId")),
    photo:
      photo instanceof File && photo.size > 0 && photo.size < 6_000_000
        ? { base64: Buffer.from(await photo.arrayBuffer()).toString("base64"), mime: "image/jpeg" }
        : null,
  };

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ScanEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runScan(input, send);
      } catch (e) {
        console.error("scan failed", e);
        send({
          type: "error",
          message: e instanceof ScanError ? e.message : "Something went wrong while scanning. Please try again.",
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
