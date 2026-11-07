import { BuildingModel } from "@/packages/schema/building-model";
import { listBuildings, upsertBuilding } from "@/lib/buildings";
import { databaseError } from "@/lib/mongo";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await listBuildings());
  } catch (error) {
    return databaseError(error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }

  const parsed = BuildingModel.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid BuildingModel",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }

  if (parsed.data.source !== "wifi") {
    return Response.json({ error: "Only Wi-Fi scanner houses can be saved" }, { status: 400 });
  }

  try {
    return Response.json(await upsertBuilding(parsed.data));
  } catch (error) {
    return databaseError(error);
  }
}
