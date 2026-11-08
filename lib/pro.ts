/** CloudScan Pro: 3-point firefighter tracking setup (Phase 1 — UI + saved config only). */

export type AnchorType = "origin" | "x" | "y";

export interface ProAnchor {
  id: "a1" | "a2" | "a3";
  /** Model frame metres: x = east, y = north. */
  x: number;
  y: number;
  type: AnchorType | null;
  ip: string;
}

export const ANCHOR_TYPE_LABEL: Record<AnchorType, string> = {
  origin: "Origin (0,0)",
  x: "X axis",
  y: "Y axis",
};

export const ANCHOR_COLOR: Record<AnchorType, string> = {
  origin: "#22d3ee",
  x: "#fbbf24",
  y: "#f472b6",
};
export const ANCHOR_UNSET_COLOR = "#5b6b61";

/** Target spacing between neighbouring points, metres. */
export const ANCHOR_SPACING_M = 8;

/** Phase 1 placeholder login — replace with real auth later. */
const DEMO_USER = "user";
const DEMO_PASS = "password";

export function checkProLogin(user: string, pass: string): boolean {
  return user.trim() === DEMO_USER && pass === DEMO_PASS;
}

const AUTH_KEY = "cloudscan-pro-auth";
const CFG_KEY = (modelId: string) => `cloudscan-pro-anchors:${modelId}`;

export function loadProAuth(): boolean {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveProAuth(on: boolean) {
  try {
    if (on) sessionStorage.setItem(AUTH_KEY, "1");
    else sessionStorage.removeItem(AUTH_KEY);
  } catch {}
}

/** Three points around the house, 8 m apart in an L (Origin, X, Y) centred on the footprint. */
export function defaultAnchors(footprint: [number, number][]): ProAnchor[] {
  const n = footprint.length || 1;
  const cx = footprint.reduce((s, p) => s + p[0], 0) / n;
  const cy = footprint.reduce((s, p) => s + p[1], 0) / n;
  const h = ANCHOR_SPACING_M / 2;
  return [
    { id: "a1", x: cx - h, y: cy - h, type: null, ip: "" },
    { id: "a2", x: cx + h, y: cy - h, type: null, ip: "" },
    { id: "a3", x: cx - h, y: cy + h, type: null, ip: "" },
  ];
}

export interface SavedSetup {
  anchors: ProAnchor[];
  /** ms since epoch; 0 = never edited (defaults). */
  updatedAt: number;
}

export function loadAnchors(modelId: string, footprint: [number, number][]): SavedSetup {
  try {
    const raw = localStorage.getItem(CFG_KEY(modelId));
    if (raw) {
      const parsed = JSON.parse(raw) as ProAnchor[] | SavedSetup;
      if (Array.isArray(parsed) && parsed.length === 3) return { anchors: parsed, updatedAt: 1 };
      if (!Array.isArray(parsed) && parsed.anchors?.length === 3) return parsed;
    }
  } catch {}
  return { anchors: defaultAnchors(footprint), updatedAt: 0 };
}

export function saveAnchors(modelId: string, setup: SavedSetup) {
  try {
    localStorage.setItem(CFG_KEY(modelId), JSON.stringify(setup));
  } catch {}
}

/** Shared copy in MongoDB (via /api/pro/setup/[id]); every call is best effort. */
export async function fetchRemoteSetup(modelId: string): Promise<SavedSetup | null> {
  try {
    const res = await fetch(`/api/pro/setup/${encodeURIComponent(modelId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as SavedSetup;
    return Array.isArray(data.anchors) && data.anchors.length === 3 ? data : null;
  } catch {
    return null;
  }
}

export async function pushRemoteSetup(modelId: string, setup: SavedSetup): Promise<void> {
  try {
    await fetch(`/api/pro/setup/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setup),
    });
  } catch {}
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const isValidIp = (ip: string) => IPV4.test(ip.trim());

export const dist = (a: ProAnchor, b: ProAnchor) => Math.hypot(a.x - b.x, a.y - b.y);

export interface SetupStatus {
  ready: boolean;
  problems: string[];
}

export function setupStatus(anchors: ProAnchor[]): SetupStatus {
  const problems: string[] = [];
  for (const t of ["origin", "x", "y"] as AnchorType[]) {
    const n = anchors.filter((a) => a.type === t).length;
    if (n === 0) problems.push(`No point set as ${ANCHOR_TYPE_LABEL[t]}`);
    if (n > 1) problems.push(`${ANCHOR_TYPE_LABEL[t]} is used more than once`);
  }
  for (const a of anchors) {
    if (!a.ip.trim()) problems.push(`Point ${a.id.toUpperCase()} has no IP address`);
    else if (!isValidIp(a.ip)) problems.push(`Point ${a.id.toUpperCase()} IP is not valid`);
  }
  const ips = anchors.map((a) => a.ip.trim()).filter(Boolean);
  if (new Set(ips).size !== ips.length) problems.push("Two points share the same IP");
  return { ready: problems.length === 0, problems };
}
