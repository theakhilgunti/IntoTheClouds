import { suggestAddresses } from "@/lib/geocode";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET /api/geocode/suggest?q=… — address typeahead for the home locate form.
 * Returns { suggestions: AddressSuggestion[] }.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 3) {
    return Response.json({ suggestions: [] });
  }
  try {
    const suggestions = await suggestAddresses(q, 6);
    return Response.json({ suggestions });
  } catch (e) {
    console.error("geocode suggest failed", e);
    return Response.json({ suggestions: [] });
  }
}
