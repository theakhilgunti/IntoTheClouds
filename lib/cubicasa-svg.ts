/**
 * Parse CubiCasa5K / CubiCasa-style floor-plan SVG annotations into a PlanRead
 * that applyFloorPlan can place onto a mapped building outline.
 *
 * CubiCasa5K SVGs use <g class="Space Kitchen">…<polygon points="…"/> and
 * <g id="Door"> / <g id="Window"> groups. Coordinates are SVG space; we normalize
 * to the 0–1000 image grid expected by applyFloorPlan.
 */
type RoomType =
  | "living" | "kitchen" | "dining" | "bedroom" | "bathroom" | "hallway" | "stair" | "garage"
  | "utility" | "closet" | "office" | "basement" | "other";

/** Matches floorplan.PlanRead — kept local so this module stays node:test friendly. */
export type CubiPlanRead = {
  readable: boolean;
  problems: string[];
  confidence: number;
  front_side: "top" | "bottom" | "left" | "right" | "unknown";
  overall_width_m: number;
  overall_depth_m: number;
  rooms: { name: string; type: RoomType; box: number[] }[];
  doors: { point: number[]; exterior: boolean }[];
};

/** Map CubiCasa Space class tokens → our RoomType. */
const SPACE_MAP: Record<string, RoomType> = {
  livingroom: "living",
  lounge: "living",
  dining: "dining",
  eatingarea: "dining",
  kitchen: "kitchen",
  bedroom: "bedroom",
  bath: "bathroom",
  sauna: "bathroom",
  hallway: "hallway",
  hall: "hallway",
  entry: "hallway",
  draughtlobby: "hallway",
  stairwell: "stair",
  stair: "stair",
  garage: "garage",
  carport: "garage",
  closet: "closet",
  dressingroom: "closet",
  storage: "closet",
  pantry: "closet",
  utility: "utility",
  technicalroom: "utility",
  serviceroom: "utility",
  office: "office",
  conferenceroom: "office",
  meetingroom: "office",
  basement: "basement",
  outdoor: "other",
  undefined: "other",
  room: "other",
  userdefined: "other",
};

type Poly = { pts: [number, number][]; label: string };

function parsePoints(raw: string): [number, number][] {
  const nums = raw.trim().replace(/,/g, " ").split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function bbox(pts: [number, number][]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (pts.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x0, y0, x1, y1 };
}

function spaceType(classAttr: string): { name: string; type: RoomType } | null {
  // e.g. "Space Kitchen" or "Space LivingRoom Foo"
  const m = /(?:^|\s)Space\s+(\S+)/i.exec(classAttr);
  if (!m) return null;
  const token = m[1];
  const key = token.replace(/[^a-zA-Z]/g, "").toLowerCase();
  const type = SPACE_MAP[key] ?? "other";
  const pretty =
    token
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .trim() || type;
  return { name: pretty, type };
}

function collectGroups(svg: string): { spaces: Poly[]; doors: [number, number][] } {
  const spaces: Poly[] = [];
  const doors: [number, number][] = [];
  // Match <g …>…</g> shallowly enough for CubiCasa (groups are not deeply nested for rooms).
  const gRe = /<g\b([^>]*)>([\s\S]*?)<\/g>/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gRe.exec(svg))) {
    const attrs = gm[1];
    const body = gm[2];
    const classM = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const idM = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const cls = classM?.[1] ?? "";
    const id = idM?.[1] ?? "";
    const polys: [number, number][][] = [];
    const pRe = /<polygon\b[^>]*\bpoints\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(body))) {
      const pts = parsePoints(pm[1]);
      if (pts.length >= 3) polys.push(pts);
    }
    if (!polys.length) continue;

    if (/^Door$/i.test(id) || /\bDoor\b/i.test(cls)) {
      for (const pts of polys) {
        const b = bbox(pts);
        if (b) doors.push([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]);
      }
      continue;
    }
    if (/^Wall$/i.test(id) || /^Railing$/i.test(id) || /^Window$/i.test(id)) continue;

    const space = spaceType(cls);
    if (!space) continue;
    if (space.type === "other" && /outdoor/i.test(cls)) continue;
    for (const pts of polys) {
      spaces.push({ pts, label: space.name + "\0" + space.type });
    }
  }
  return { spaces, doors };
}

function viewBoxSize(svg: string): { w: number; h: number } {
  const vb = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*["']/i.exec(svg);
  if (vb) return { w: Math.abs(Number(vb[3])), h: Math.abs(Number(vb[4])) };
  const w = /\bwidth\s*=\s*["']([-\d.eE]+)/i.exec(svg);
  const h = /\bheight\s*=\s*["']([-\d.eE]+)/i.exec(svg);
  return { w: Math.abs(Number(w?.[1] ?? 1000)) || 1000, h: Math.abs(Number(h?.[1] ?? 1000)) || 1000 };
}

/**
 * Convert CubiCasa / CubiCasa5K SVG text into a PlanRead for applyFloorPlan.
 * Returns readable:false with problems when the SVG has no usable Space polygons.
 */
export function readCubiCasaSvg(svgText: string): CubiPlanRead {
  const svg = svgText.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<svg[\s>]/i.test(svg)) {
    return {
      readable: false,
      problems: ["File is not an SVG floor-plan annotation."],
      confidence: 0,
      front_side: "unknown",
      overall_width_m: 0,
      overall_depth_m: 0,
      rooms: [],
      doors: [],
    };
  }

  const { spaces, doors } = collectGroups(svg);
  if (spaces.length < 3) {
    return {
      readable: false,
      problems: [
        `Only ${spaces.length} CubiCasa Space polygon(s) found — need a CubiCasa5K / CubiCasa SVG with class="Space …" room groups.`,
      ],
      confidence: 0,
      front_side: "unknown",
      overall_width_m: 0,
      overall_depth_m: 0,
      rooms: [],
      doors: [],
    };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const boxes: { name: string; type: RoomType; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const s of spaces) {
    const b = bbox(s.pts);
    if (!b) continue;
    const [name, type] = s.label.split("\0") as [string, RoomType];
    boxes.push({ name, type, ...b });
    if (b.x0 < minX) minX = b.x0;
    if (b.y0 < minY) minY = b.y0;
    if (b.x1 > maxX) maxX = b.x1;
    if (b.y1 > maxY) maxY = b.y1;
  }
  if (boxes.length < 3 || !(maxX > minX) || !(maxY > minY)) {
    return {
      readable: false,
      problems: ["CubiCasa SVG rooms could not be bounded."],
      confidence: 0,
      front_side: "unknown",
      overall_width_m: 0,
      overall_depth_m: 0,
      rooms: [],
      doors: [],
    };
  }

  // Prefer content bbox; fall back to viewBox if rooms hug the canvas.
  const vb = viewBoxSize(svg);
  const W = Math.max(maxX - minX, vb.w * 0.05);
  const D = Math.max(maxY - minY, vb.h * 0.05);
  const toGrid = (x: number, y: number): [number, number] => [
    Math.round(((y - minY) / D) * 1000),
    Math.round(((x - minX) / W) * 1000),
  ];

  const rooms = boxes.map((b) => {
    const [y0, x0] = toGrid(b.x0, b.y0);
    const [y1, x1] = toGrid(b.x1, b.y1);
    return {
      name: b.name,
      type: b.type,
      box: [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)],
    };
  });

  const doorPts = doors.map(([x, y]) => {
    const [gy, gx] = toGrid(x, y);
    return { point: [gy, gx], exterior: false };
  });

  // Heuristic: doors nearest the outer bbox edge → exterior.
  for (const d of doorPts) {
    const [y, x] = d.point;
    const edge = Math.min(y, x, 1000 - y, 1000 - x);
    d.exterior = edge < 40;
  }

  return {
    readable: true,
    problems: [],
    confidence: 0.92,
    front_side: "unknown",
    overall_width_m: 0,
    overall_depth_m: 0,
    rooms,
    doors: doorPts,
  };
}

/** True when the file looks like CubiCasa / CubiCasa5K SVG annotations. */
export function looksLikeCubiCasaSvg(text: string): boolean {
  return /<svg[\s>]/i.test(text) && /(?:class\s*=\s*["'][^"']*Space\s)/i.test(text);
}
