import { z } from "zod";
import { databaseError, getDb } from "@/lib/mongo";

export const runtime = "nodejs";

const Anchor = z.object({
  id: z.enum(["a1", "a2", "a3"]),
  x: z.number(),
  y: z.number(),
  type: z.enum(["origin", "x", "y"]).nullable(),
  ip: z.string().max(45),
});
const Body = z.object({ anchors: z.array(Anchor).length(3), updatedAt: z.number() });

/** CloudScan Pro: the 3-point tracking setup for a house, shared across devices (Mongo `proSetups`). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const db = await getDb();
    const doc = await db.collection("proSetups").findOne({ _id: id as never });
    if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ anchors: doc.anchors, updatedAt: doc.updatedAt });
  } catch (error) {
    return databaseError(error);
  }
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Invalid setup" }, { status: 400 });
  try {
    const db = await getDb();
    await db
      .collection("proSetups")
      .updateOne({ _id: id as never }, { $set: { ...parsed.data } }, { upsert: true });
    return Response.json({ ok: true });
  } catch (error) {
    return databaseError(error);
  }
}
