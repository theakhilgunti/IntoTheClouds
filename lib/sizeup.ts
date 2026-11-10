/**
 * Firefighter size-up brief: stories, hydrants, shutoffs, dual egress, exposures.
 * Pure computation over BuildingModel + optional live markers — no React.
 */
import type { BuildingModel, Marker, Point } from "../packages/schema/building-model";
import {
  buildNav,
  dualEgress,
  stairCutOff,
  type Route,
} from "./route";

export type SizeUp = {
  stories: number;
  basement: boolean;
  interiorStatus: "verified" | "estimated" | "unknown";
  hydrants: { label: string; distM: number; pos: [number, number] }[];
  shutoffs: { kind: "gas" | "electric"; note: string; floor: number; pos: [number, number] }[];
  egress: {
    primary: Route | null;
    secondary: Route | null;
    cutOff: boolean;
  };
  exposures: { label: string; distM: number }[];
  summaryLine: string;
};

function footprintCentroid(fp: Point[]): Point {
  if (!fp.length) return [0, 0];
  return [
    fp.reduce((s, p) => s + p[0], 0) / fp.length,
    fp.reduce((s, p) => s + p[1], 0) / fp.length,
  ];
}

function ringCentroid(poly: Point[]): Point {
  return footprintCentroid(poly);
}

function dist2(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Origin for yard distances: front door if known, else footprint centroid. */
function distanceOrigin(model: BuildingModel): Point {
  const ground =
    model.floors.filter((f) => f.level >= 0 && f.doors.some((d) => d.exit)).sort((a, b) => a.level - b.level)[0] ??
    model.floors.find((f) => f.doors.some((d) => d.exit));
  if (ground) {
    const exits = ground.doors.filter((d) => d.exit && ground.walls.some((w) => w.id === d.wallId));
    const door =
      exits.find((d) => /front/i.test(d.id)) ??
      [...exits].sort((a, b) => {
        const wa = ground.walls.find((w) => w.id === a.wallId)!;
        const wb = ground.walls.find((w) => w.id === b.wallId)!;
        const ya = wa.a[1] + (wa.b[1] - wa.a[1]) * a.t;
        const yb = wb.a[1] + (wb.b[1] - wb.a[1]) * b.t;
        return ya - yb;
      })[0];
    if (door) {
      const w = ground.walls.find((wall) => wall.id === door.wallId)!;
      return [w.a[0] + (w.b[0] - w.a[0]) * door.t, w.a[1] + (w.b[1] - w.a[1]) * door.t];
    }
  }
  return footprintCentroid(model.footprint);
}

function classifyShutoff(note: string): "gas" | "electric" | null {
  const n = note.toLowerCase();
  if (/electric|panel|breaker|subpanel/.test(n)) return "electric";
  if (/gas/.test(n)) return "gas";
  return null;
}

function interiorStatusOf(model: BuildingModel): SizeUp["interiorStatus"] {
  if (model.interior?.status) return model.interior.status;
  const hasRooms = model.floors.some((f) => f.rooms.length > 0);
  return hasRooms ? "verified" : "unknown";
}

function focusMarker(markers: Marker[]): Marker | null {
  return markers.find((m) => m.type === "fire") ?? markers.find((m) => m.type === "victim") ?? null;
}

/** When no fire/victim pin exists, pick a ground-floor room center so Size-up still shows dual egress. */
function defaultInteriorFocus(model: BuildingModel): Pick<Marker, "floor" | "pos"> | null {
  const ground =
    model.floors.find((f) => f.level === 0) ??
    model.floors.filter((f) => f.level >= 0).sort((a, b) => a.level - b.level)[0];
  if (!ground?.rooms.length) return null;
  const preferred =
    ground.rooms.find((r) => r.type === "living") ??
    ground.rooms.find((r) => r.type === "bedroom") ??
    ground.rooms.find((r) => r.type !== "stair" && r.type !== "hallway") ??
    ground.rooms[0];
  if (!preferred.polygon.length) return null;
  const pos = ringCentroid(preferred.polygon);
  return { floor: ground.level, pos };
}

function fmtLen(m: number | undefined | null): string {
  if (m == null || !Number.isFinite(m)) return "?";
  return `${m.toFixed(0)} m`;
}

function buildSummary(s: Omit<SizeUp, "summaryLine">): string {
  const parts: string[] = [];
  parts.push(
    s.basement
      ? `${s.stories}-story with basement`
      : `${s.stories}-story`,
  );
  parts.push(`interior ${s.interiorStatus}`);
  if (s.hydrants[0]) parts.push(`hydrant ${fmtLen(s.hydrants[0].distM)}`);
  else parts.push("no mapped hydrant");
  if (s.shutoffs.length) {
    const kinds = [...new Set(s.shutoffs.map((x) => x.kind))].join("/");
    parts.push(`${kinds} shutoff marked`);
  }
  if (s.egress.cutOff) parts.push("STAIR CUT-OFF");
  else if (s.egress.primary && s.egress.secondary) {
    parts.push(`dual egress ${fmtLen(s.egress.primary.length)} / ${fmtLen(s.egress.secondary.length)}`);
  } else if (s.egress.primary) {
    parts.push(`single egress ${fmtLen(s.egress.primary.length)}`);
  } else {
    parts.push("egress unknown");
  }
  if (s.exposures[0]) parts.push(`exposure ${s.exposures[0].label} @ ${fmtLen(s.exposures[0].distM)}`);
  return parts.join(" — ") + ".";
}

/**
 * Compute an IC size-up card payload from the building model and optional live markers.
 */
export function computeSizeUp(model: BuildingModel, markers?: Marker[]): SizeUp {
  const marks = markers ?? model.markers ?? [];
  const levels = model.floors.map((f) => f.level);
  const above = levels.filter((l) => l >= 0);
  const stories = above.length ? Math.max(...above) - Math.min(...above) + 1 : 0;
  const basement = levels.some((l) => l < 0);
  const interiorStatus = interiorStatusOf(model);
  const origin = distanceOrigin(model);

  const hydrants = (model.compound?.features ?? [])
    .filter((f) => f.kind === "hydrant")
    .map((f) => {
      const pos = ringCentroid(f.polygon) as [number, number];
      return { label: f.label || "Hydrant", distM: dist2(origin, pos), pos };
    })
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 3);

  const shutoffs: SizeUp["shutoffs"] = [];
  for (const m of marks.filter((x) => x.type === "shutoff")) {
    const kind = classifyShutoff(m.note);
    if (!kind) continue;
    shutoffs.push({
      kind,
      note: m.note || (kind === "gas" ? "Gas shutoff" : "Electric panel"),
      floor: m.floor,
      pos: [m.pos[0], m.pos[1]],
    });
  }

  const exposures = (model.compound?.features ?? [])
    .filter((f) => f.kind === "neighbor")
    .map((f) => {
      const pos = ringCentroid(f.polygon);
      return { label: f.label || "Neighbor", distM: dist2(origin, pos) };
    })
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 4);

  const nav = buildNav(model);
  const focus = focusMarker(marks) ?? defaultInteriorFocus(model);
  const { primary, secondary } = focus
    ? dualEgress(nav, focus)
    : { primary: null, secondary: null };
  const cutOff = stairCutOff(nav, marks);

  const partial: Omit<SizeUp, "summaryLine"> = {
    stories,
    basement,
    interiorStatus,
    hydrants,
    shutoffs,
    egress: { primary, secondary, cutOff },
    exposures,
  };
  return { ...partial, summaryLine: buildSummary(partial) };
}
