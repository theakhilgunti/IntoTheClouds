import { store } from "@/lib/store";
import { getBuilding } from "@/lib/buildings";
import { MongoNotConfigured } from "@/lib/mongo";
import type { ScanResult } from "@/lib/sources";

export const runtime = "nodejs";

/** GET /api/models/:id -> a saved scan, or a Wi-Fi scanner house, or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const saved = await store.get(id);
  if (saved) return Response.json(saved);

  try {
    const house = await getBuilding(id);
    if (!house || house.model.source !== "wifi") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const result: ScanResult = {
      model: house.model,
      sources: [{ id: "wifi", name: "Wi-Fi scanner", status: "used", detail: "Walk saved from the scanner" }],
      attributes: [],
      warnings: [],
      images: [],
      summary: {
        width: house.dimensions.widthM,
        depth: house.dimensions.depthM,
        area: house.dimensions.footprintAreaM2,
        facing: "",
        stories: house.dimensions.floorCount,
      },
      createdAt: house.updatedAt,
    };
    return Response.json(result);
  } catch (error) {
    if (error instanceof MongoNotConfigured) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    console.error(error);
    return Response.json({ error: "Database error" }, { status: 500 });
  }
}
