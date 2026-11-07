import { store } from "@/lib/scan/store";

export const runtime = "nodejs";

/** GET /api/models/:id -> saved ScanResult, or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const saved = await store.get(id);
  if (!saved) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(saved);
}
