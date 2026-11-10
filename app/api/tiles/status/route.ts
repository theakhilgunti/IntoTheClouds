/**
 * Google Photorealistic 3D Tiles bootstrap.
 * Key stays server-side in the returned URL for Cesium (short-lived page session).
 *
 * Env: GOOGLE_MAPS_3D_API_KEY (Map Tiles API + Photorealistic 3D Tiles).
 *
 * Important: 3D Tiles do NOT use createSession (that’s for 2D / Street View).
 * Passing a 2D session into root.json often yields HTTP 400 on tile fetches.
 * Restrict the key with HTTP referrers including `http://localhost:3000/*`.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ok = { ok: true; tilesetUrl: string };
type Fail = { ok: false; reason: string };

export async function GET(): Promise<NextResponse<Ok | Fail>> {
  const key = process.env.GOOGLE_MAPS_3D_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({
      ok: false,
      reason: "Set GOOGLE_MAPS_3D_API_KEY to enable the city mesh underlay.",
    });
  }

  // Probe root once so the UI can fail fast with Google’s message (billing / API enablement).
  try {
    const tilesetUrl = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`;
    const res = await fetch(tilesetUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json({
        ok: false,
        reason: `3D tiles root failed (HTTP ${res.status}). Check Map Tiles API + key referrers (include localhost). ${body.slice(0, 140)}`,
      });
    }
    return NextResponse.json({ ok: true, tilesetUrl });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reason: e instanceof Error ? e.message : "Tile root error",
    });
  }
}
