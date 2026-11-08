/**
 * University / library academic plans — pure (no schema / network) for node:test.
 */

type Rect = { x0: number; y0: number; x1: number; y1: number };
type RoomType =
  | "living"
  | "kitchen"
  | "dining"
  | "bedroom"
  | "bathroom"
  | "hallway"
  | "stair"
  | "garage"
  | "utility"
  | "closet"
  | "office"
  | "basement"
  | "other";

export type CampusPlanRoom = { id: string; name: string; type: RoomType; r: Rect; zone: string };
export type CampusPlanFloor = { level: number; rooms: CampusPlanRoom[]; stair: Rect | null };

export type CampusSpec = {
  width: number;
  depth: number;
  stories: number;
};

const STAIR_LEN = 3.6;

/**
 * University academic building: atrium / lecture hall on the ground floor;
 * upper floors mix seminar rooms, labs, and faculty offices along a corridor.
 * Distinct from K–12 (no nurse/cafeteria/gym wing).
 */
export function planUniversity(spec: CampusSpec, notes: string[]): CampusPlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const hallW = Math.min(2.6, Math.max(1.8, W * 0.11));
  const hx0 = -hallW / 2, hx1 = hallW / 2;
  const hasStairs = spec.stories > 1;
  const stairLen = Math.min(STAIR_LEN, D * 0.18);
  const lobbyD = Math.min(7, Math.max(4, D * 0.2));
  const stair: Rect | null = hasStairs
    ? { x0: hx0, y0: y0 + lobbyD, x1: hx1, y1: y0 + lobbyD + stairLen }
    : null;
  const floors: CampusPlanFloor[] = [];
  const rows = Math.max(2, Math.min(5, Math.round(D / 9)));

  for (let lv = 0; lv < spec.stories; lv++) {
    const prefix = `u${lv}`;
    const rooms: CampusPlanRoom[] = [];
    if (lv === 0) {
      rooms.push(
        { id: `${prefix}-atrium`, name: "Atrium / Lobby", type: "hallway", r: { x0, y0, x1, y1: y0 + lobbyD }, zone: "lobby" },
        {
          id: `${prefix}-lecture`,
          name: "Lecture Hall",
          type: "other",
          r: { x0, y0: y0 + lobbyD, x1: hx0, y1: y0 + lobbyD + Math.min(12, D * 0.35) },
          zone: "lecture",
        },
        {
          id: `${prefix}-cafe`,
          name: "Café / Lounge",
          type: "other",
          r: { x0: hx1, y0: y0 + lobbyD, x1, y1: y0 + lobbyD + Math.min(12, D * 0.35) },
          zone: "cafe",
        },
      );
      const workY0 = y0 + lobbyD + Math.min(12, D * 0.35);
      const edges = Array.from({ length: rows + 1 }, (_, i) => workY0 + ((y1 - workY0) * i) / rows);
      let n = 1;
      for (let i = 0; i < rows; i++) {
        const yA = edges[i], yB = edges[i + 1];
        if (yB - yA < 2.4) continue;
        rooms.push({
          id: `${prefix}-semL${i}`,
          name: `Seminar ${n++}`,
          type: "office",
          r: { x0, y0: yA, x1: hx0, y1: yB },
          zone: `semL${i}`,
        });
        rooms.push({
          id: `${prefix}-labR${i}`,
          name: i % 2 === 0 ? `Lab ${n}` : `Faculty Office ${n}`,
          type: i % 2 === 0 ? "other" : "office",
          r: { x0: hx1, y0: yA, x1, y1: yB },
          zone: `semR${i}`,
        });
        n++;
      }
      const bathY0 = y1 - 3.2;
      rooms.push({
        id: `${prefix}-bath`,
        name: "Restrooms",
        type: "bathroom",
        r: { x0: hx0, y0: bathY0, x1: hx1, y1 },
        zone: "bath",
      });
      // Corridor stops at the bath so polygons don't nest (avoids walls through rooms).
      rooms.push({
        id: `${prefix}-hall`,
        name: "Corridor",
        type: "hallway",
        r: { x0: hx0, y0: y0 + lobbyD, x1: hx1, y1: bathY0 },
        zone: "hall",
      });
    } else {
      const bathY0 = y1 - 3.2;
      const edges = Array.from({ length: rows + 1 }, (_, i) => y0 + (D * i) / rows);
      let n = 1;
      for (let i = 0; i < rows; i++) {
        const yA = edges[i], yB = edges[i + 1];
        if (yB - yA < 2.4) continue;
        const leftLab = i % 2 === 0;
        rooms.push({
          id: `${prefix}-L${i}`,
          name: leftLab ? `Teaching Lab ${lv}${n}` : `Seminar ${lv}${n}`,
          type: leftLab ? "other" : "office",
          r: { x0, y0: yA, x1: hx0, y1: yB },
          zone: `L${i}`,
        });
        n++;
        rooms.push({
          id: `${prefix}-R${i}`,
          name: !leftLab ? `Research Lab ${lv}${n}` : `Faculty Office ${lv}${n}`,
          type: !leftLab ? "other" : "office",
          r: { x0: hx1, y0: yA, x1, y1: yB },
          zone: `R${i}`,
        });
        n++;
      }
      rooms.push({
        id: `${prefix}-bath`,
        name: "Restrooms",
        type: "bathroom",
        r: { x0: hx0, y0: bathY0, x1: hx1, y1 },
        zone: "bath",
      });
      rooms.push({
        id: `${prefix}-hall`,
        name: "Corridor",
        type: "hallway",
        r: { x0: hx0, y0, x1: hx1, y1: bathY0 },
        zone: "hall",
      });
    }
    if (stair) rooms.push({ id: `${prefix}-stair`, name: "Stairs", type: "stair", r: stair, zone: "stair" });
    floors.push({ level: lv, rooms, stair });
  }
  notes.push(
    `University-style academic layout: atrium and lecture hall on the ground floor, labs/seminars/faculty offices above` +
      (spec.stories > 1 ? ` (${spec.stories} levels)` : "") +
      `. Typical campus plan, not a measured survey.`,
  );
  return floors;
}

/** Public / campus library: lobby + stacks/reading; upper floors are study / stacks. */
export function planLibrary(spec: CampusSpec, notes: string[]): CampusPlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const lobbyD = Math.min(6, Math.max(3.5, D * 0.16));
  const hasStairs = spec.stories > 1;
  const hx0 = -1.2, hx1 = 1.2;
  const stair: Rect | null = hasStairs
    ? { x0: hx0, y0: y0 + lobbyD, x1: hx1, y1: y0 + lobbyD + Math.min(STAIR_LEN, D * 0.16) }
    : null;
  const floors: CampusPlanFloor[] = [];
  for (let lv = 0; lv < spec.stories; lv++) {
    const prefix = `lib${lv}`;
    const rooms: CampusPlanRoom[] = [];
    if (lv === 0) {
      rooms.push(
        { id: `${prefix}-lobby`, name: "Entrance Lobby", type: "hallway", r: { x0, y0, x1, y1: y0 + lobbyD }, zone: "lobby" },
        { id: `${prefix}-desk`, name: "Circulation Desk", type: "office", r: { x0: hx0 - 2, y0: y0 + lobbyD, x1: hx1 + 2, y1: y0 + lobbyD + 3.5 }, zone: "desk" },
        { id: `${prefix}-stacksL`, name: "Stacks / Reading", type: "other", r: { x0, y0: y0 + lobbyD + 3.5, x1: 0, y1 }, zone: "stacksL" },
        { id: `${prefix}-stacksR`, name: "Stacks / Reading", type: "other", r: { x0: 0, y0: y0 + lobbyD + 3.5, x1, y1 }, zone: "stacksR" },
        { id: `${prefix}-bath`, name: "Restrooms", type: "bathroom", r: { x0: x1 - Math.min(5, W * 0.18), y0: y0 + lobbyD, x1, y1: y0 + lobbyD + 3.5 }, zone: "bath" },
        { id: `${prefix}-media`, name: "Media / Computers", type: "office", r: { x0, y0: y0 + lobbyD, x1: hx0 - 2, y1: y0 + lobbyD + 3.5 }, zone: "media" },
      );
    } else {
      const midY = (y0 + y1) / 2;
      rooms.push(
        { id: `${prefix}-hall`, name: "Floor Lobby", type: "hallway", r: { x0: hx0 - 1.5, y0, x1: hx1 + 1.5, y1: y0 + 4 }, zone: "hall" },
        { id: `${prefix}-stacksL`, name: "Stacks", type: "other", r: { x0, y0: y0 + 4, x1: 0, y1: midY }, zone: "stacksL" },
        { id: `${prefix}-stacksR`, name: "Stacks", type: "other", r: { x0: 0, y0: y0 + 4, x1, y1: midY }, zone: "stacksR" },
        { id: `${prefix}-study`, name: "Study Rooms", type: "office", r: { x0, y0: midY, x1: hx0, y1 }, zone: "study" },
        { id: `${prefix}-quiet`, name: "Quiet Reading", type: "other", r: { x0: hx1, y0: midY, x1, y1 }, zone: "quiet" },
        { id: `${prefix}-bath`, name: "Restrooms", type: "bathroom", r: { x0: hx0, y0: midY, x1: hx1, y1: midY + 3.2 }, zone: "bath" },
      );
    }
    if (stair) rooms.push({ id: `${prefix}-stair`, name: "Stairs", type: "stair", r: stair, zone: "stair" });
    floors.push({ level: lv, rooms, stair });
  }
  notes.push(
    `Library-style layout: lobby and circulation desk at the entrance with stacks/reading beyond` +
      (spec.stories > 1 ? `; study floors above` : "") +
      `. Estimated public plan, not measured.`,
  );
  return floors;
}
