import { z } from "zod";
import { recordExploration } from "@/lib/buildings";
import { databaseError } from "@/lib/mongo";

export const runtime = "nodejs";

const ExplorationRequest = z.object({
  buildingId: z.string().min(1),
  deviceId: z.string().min(1).default("FF_Pi_Rig_1"),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  lat: z.number().default(42.7298),
  lng: z.number().default(-73.6789),
  address: z.string().default("Explored structure"),
  breadcrumbs: z
    .array(z.object({ x: z.number(), y: z.number(), z: z.number().optional() }))
    .min(2),
  hazards: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional().default(""),
        hazard_type: z.string(),
        x: z.number(),
        y: z.number(),
        z: z.number().optional(),
        note: z.string().nullable().optional(),
        timestamp: z.number(),
      }),
    )
    .default([]),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }

  const parsed = ExplorationRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid exploration",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }

  try {
    return Response.json(await recordExploration(parsed.data));
  } catch (error) {
    return databaseError(error);
  }
}
