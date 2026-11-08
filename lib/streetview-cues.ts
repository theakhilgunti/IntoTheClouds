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
