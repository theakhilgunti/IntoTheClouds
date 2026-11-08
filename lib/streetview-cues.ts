/** Pure Street View merge / heading helpers (no network, no geo imports — node:test friendly). */

/** Pick heading offsets that show the front and both flanks (garage / entry cues). */
export function facadeHeadings(lookHeading: number): number[] {
  const wrap = (h: number) => ((h % 360) + 360) % 360;
  return [wrap(lookHeading), wrap(lookHeading - 38), wrap(lookHeading + 38)];
}

/** Soft merge: Street View garage wins when aerial/user vision is unknown or low-confidence. */
export function mergeGarageCue(
  primary: "none" | "attached_left" | "attached_right" | "detached" | "unknown" | undefined,
  streetView: "none" | "attached_left" | "attached_right" | "detached" | "unknown" | undefined,
  opts?: { primaryConfidence?: number; streetViewConfidence?: number },
): "none" | "attached_left" | "attached_right" | "detached" | "unknown" {
  const p = primary ?? "unknown";
  const s = streetView ?? "unknown";
  const pc = opts?.primaryConfidence ?? 0.5;
  const sc = opts?.streetViewConfidence ?? 0.5;
  if (s === "unknown") return p;
  if (p === "unknown") return s;
  if (p === s) return p;
  // Prefer the stronger reading; Street View slightly favored for attached left/right (facade cue).
  if (sc >= pc + 0.08) return s;
  if (pc >= sc + 0.12) return p;
  if ((s === "attached_left" || s === "attached_right") && (p === "none" || p === "detached")) return s;
  if (s === "none" && p === "detached" && sc >= 0.55) return s;
  return p;
}

/** Prefer Street View story count when it is confident and disagrees with aerial-only. */
export function mergeStoriesCue(
  primary: number | undefined,
  streetView: number | undefined,
  opts?: { streetViewConfidence?: number; hadUserPhoto?: boolean },
): number | undefined {
  if (streetView == null || !Number.isFinite(streetView)) return primary;
  if (primary == null || !Number.isFinite(primary)) return streetView;
  if (primary === streetView) return primary;
  if (opts?.hadUserPhoto) return primary;
  if ((opts?.streetViewConfidence ?? 0) >= 0.5) return streetView;
  return primary;
}

/**
 * Front-door position along the street facade as seen from the road (0 = left, 1 = right).
 * Prefers an explicit Gemini `front_door_t`; falls back to entry left/center/right.
 */
export function frontDoorFractionFromFacade(opts: {
  entry?: "center" | "left" | "right" | "unknown";
  frontDoorT?: number | null;
}): number {
  const t = opts.frontDoorT;
  if (t != null && Number.isFinite(t)) return Math.min(0.85, Math.max(0.15, t));
  if (opts.entry === "left") return 0.28;
  if (opts.entry === "right") return 0.72;
  return 0.5;
}

/**
 * Soft bay count from Street View front-window rhythm, clamped near the depth-based estimate.
 * `baseBays` is typically `roomBays(depth)`.
 */
export function nudgeRoomBays(baseBays: number, frontWindows: number | null | undefined): number {
  const base = Math.max(2, Math.min(4, Math.round(baseBays)));
  if (frontWindows == null || !Number.isFinite(frontWindows) || frontWindows < 1) return base;
  const w = Math.round(frontWindows);
  let fromWin = w;
  if (w >= 7) fromWin = 4;
  else if (w === 5 || w === 6) fromWin = 3;
  fromWin = Math.max(2, Math.min(4, fromWin));
  if (fromWin > base + 1) return base + 1;
  if (fromWin < base - 1) return Math.max(2, base - 1);
  return fromWin;
}
