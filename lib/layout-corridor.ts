/**
 * Multi-unit corridor programs with distinct ground vs upper floors.
 * Pure (no schema / network) so node:test can load it.
 */

export type CorridorUnitKind = "dormitory" | "apartments" | "hotel" | "hospital";

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

export type CorridorPlanRoom = { id: string; name: string; type: RoomType; r: Rect; zone: string };
export type CorridorPlanFloor = { level: number; rooms: CorridorPlanRoom[]; stair: Rect | null };

export type CorridorSpec = {
  width: number;
  depth: number;
  stories: number;
  bays?: number | null;
};

const STAIR_LEN = 3.6;

/** Split depth into `n` bands from yA→yB. */
function depthEdges(yA: number, yB: number, n: number): number[] {
  const rows = Math.max(1, n);
  return Array.from({ length: rows + 1 }, (_, i) => yA + ((yB - yA) * i) / rows);
}

/** Hotel / hospital / dorm / apt: ground program ≠ upper residential/guest/ward floors. */
export function planCorridorUnits(spec: CorridorSpec, notes: string[], kind: CorridorUnitKind): CorridorPlanFloor[] {
  const W = spec.width, D = spec.depth;
  const x0 = -W / 2, x1 = W / 2, y0 = -D / 2, y1 = D / 2;
  const hallW = Math.min(2.6, Math.max(1.5, W * 0.11));
  const hx0 = -hallW / 2, hx1 = hallW / 2;
  const hasStairs = spec.stories > 1;
  const stairLen = Math.min(STAIR_LEN, D * 0.18);
  const frontD =
    kind === "hotel" || kind === "hospital"
      ? Math.min(7, Math.max(3.5, D * 0.18))
      : kind === "apartments"
        ? Math.min(5, Math.max(3, D * 0.14))
        : Math.min(5, Math.max(3.2, D * 0.14));
  const stairY0 = y0 + frontD;
  const stair: Rect | null = hasStairs
    ? { x0: hx0, y0: stairY0, x1: hx1, y1: stairY0 + stairLen }
    : null;
  const unitRows = Math.max(2, Math.min(8, spec.bays ?? Math.round(D / (kind === "apartments" ? 9 : 6.5))));
  const floors: CorridorPlanFloor[] = [];

  for (let lv = 0; lv < spec.stories; lv++) {
    const prefix = `${kind[0]}${lv}`;
    const rooms: CorridorPlanRoom[] = [];
    if (stair) rooms.push({ id: `${prefix}-stair`, name: "Stairs", type: "stair", r: stair, zone: "stair" });

    if (lv === 0) {
      if (kind === "hotel") {
        const mid = y0 + frontD + (y1 - y0 - frontD) * 0.45;
        const bathY1 = mid + Math.min(3.2, (y1 - mid) * 0.4);
        rooms.push(
          { id: `${prefix}-lobby`, name: "Lobby / Reception", type: "hallway", r: { x0, y0, x1, y1: y0 + frontD }, zone: "lobby" },
          // Corridor above the bath band only — bath sits in the hall strip without nesting.
          { id: `${prefix}-hall`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: y0 + frontD, x1: hx1, y1: mid }, zone: "hall" },
          { id: `${prefix}-hall2`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: bathY1, x1: hx1, y1 }, zone: "hall" },
          { id: `${prefix}-rest`, name: "Restaurant / Bar", type: "other", r: { x0, y0: y0 + frontD, x1: hx0, y1: mid }, zone: "rest" },
          { id: `${prefix}-meet`, name: "Meeting / Ballroom", type: "other", r: { x0: hx1, y0: y0 + frontD, x1, y1: mid }, zone: "meet" },
          { id: `${prefix}-kit`, name: "Kitchen / Service", type: "utility", r: { x0, y0: mid, x1: hx0, y1 }, zone: "kit" },
          { id: `${prefix}-boh`, name: "Back of House", type: "utility", r: { x0: hx1, y0: mid, x1, y1 }, zone: "boh" },
          { id: `${prefix}-bath`, name: "Restrooms", type: "bathroom", r: { x0: hx0, y0: mid, x1: hx1, y1: bathY1 }, zone: "bath" },
        );
      } else if (kind === "hospital") {
        const mid = y0 + frontD + (y1 - y0 - frontD) * 0.4;
        const rear = mid + (y1 - mid) * 0.55;
        const bathY1 = mid + Math.min(3.2, (rear - mid) * 0.5);
        rooms.push(
          { id: `${prefix}-lobby`, name: "Lobby / Admitting", type: "hallway", r: { x0, y0, x1, y1: y0 + frontD }, zone: "lobby" },
          { id: `${prefix}-hall`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: y0 + frontD, x1: hx1, y1: mid }, zone: "hall" },
          { id: `${prefix}-hall2`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: bathY1, x1: hx1, y1 }, zone: "hall" },
          { id: `${prefix}-ed`, name: "Emergency / Triage", type: "other", r: { x0, y0: y0 + frontD, x1: hx0, y1: mid }, zone: "ed" },
          { id: `${prefix}-img`, name: "Imaging / Labs", type: "other", r: { x0: hx1, y0: y0 + frontD, x1, y1: mid }, zone: "img" },
          { id: `${prefix}-clinicL`, name: "Outpatient Clinic", type: "office", r: { x0, y0: mid, x1: hx0, y1: rear }, zone: "clinicL" },
          { id: `${prefix}-clinicR`, name: "Consultation", type: "office", r: { x0: hx1, y0: mid, x1, y1: rear }, zone: "clinicR" },
          { id: `${prefix}-pharm`, name: "Pharmacy", type: "other", r: { x0, y0: rear, x1: hx0, y1 }, zone: "pharm" },
          { id: `${prefix}-admin`, name: "Admin / Records", type: "office", r: { x0: hx1, y0: rear, x1, y1 }, zone: "admin" },
          { id: `${prefix}-bath`, name: "Restrooms", type: "bathroom", r: { x0: hx0, y0: mid, x1: hx1, y1: bathY1 }, zone: "bath" },
        );
      } else if (kind === "dormitory") {
        const mid = y0 + frontD + (y1 - y0 - frontD) * 0.5;
        const bathY1 = mid + Math.min(3, (y1 - mid) * 0.4);
        rooms.push(
          { id: `${prefix}-lounge`, name: "Lounge / Common Room", type: "living", r: { x0, y0, x1: hx0, y1: y0 + frontD }, zone: "lounge" },
          { id: `${prefix}-ra`, name: "RA / Front Desk", type: "office", r: { x0: hx1, y0, x1, y1: y0 + frontD }, zone: "ra" },
          { id: `${prefix}-hall`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0, x1: hx1, y1: mid }, zone: "hall" },
          { id: `${prefix}-hall2`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: bathY1, x1: hx1, y1 }, zone: "hall" },
          { id: `${prefix}-study`, name: "Study Lounge", type: "other", r: { x0, y0: y0 + frontD, x1: hx0, y1: mid }, zone: "study" },
          { id: `${prefix}-laundry`, name: "Laundry", type: "utility", r: { x0: hx1, y0: y0 + frontD, x1, y1: mid }, zone: "laundry" },
          { id: `${prefix}-kit`, name: "Kitchenette", type: "kitchen", r: { x0, y0: mid, x1: hx0, y1 }, zone: "kit" },
          { id: `${prefix}-mail`, name: "Mail / Storage", type: "utility", r: { x0: hx1, y0: mid, x1, y1 }, zone: "mail" },
          { id: `${prefix}-bath`, name: "Shared Bath", type: "bathroom", r: { x0: hx0, y0: mid, x1: hx1, y1: bathY1 }, zone: "bath" },
        );
      } else {
        const mailY1 = y0 + frontD + Math.min(3, D * 0.1);
        rooms.push(
          { id: `${prefix}-lobby`, name: "Lobby / Entry", type: "hallway", r: { x0, y0, x1, y1: y0 + frontD }, zone: "lobby" },
          { id: `${prefix}-hall`, name: "Ground Corridor", type: "hallway", r: { x0: hx0, y0: mailY1, x1: hx1, y1 }, zone: "hall" },
          { id: `${prefix}-mail`, name: "Mail / Package", type: "utility", r: { x0: hx0, y0: y0 + frontD, x1: hx1, y1: mailY1 }, zone: "mail" },
        );
        const gRows = Math.max(1, Math.min(3, Math.floor(unitRows / 2)));
        const edges = depthEdges(y0 + frontD + 0.5, y1, gRows);
        let unitNo = 1;
        for (let i = 0; i < gRows; i++) {
          const yA = edges[i], yB = edges[i + 1];
          if (yB - yA < 2.2) continue;
          const midY = (yA + yB) / 2;
          rooms.push(
            { id: `${prefix}-uL${i}liv`, name: `Unit G${String(unitNo).padStart(2, "0")} Living`, type: "living", r: { x0, y0: yA, x1: hx0, y1: midY }, zone: `uL${i}` },
            { id: `${prefix}-uL${i}bed`, name: `Unit G${String(unitNo).padStart(2, "0")} Bedroom`, type: "bedroom", r: { x0, y0: midY, x1: hx0, y1: yB }, zone: `uL${i}` },
          );
          unitNo++;
          rooms.push(
            { id: `${prefix}-uR${i}liv`, name: `Unit G${String(unitNo).padStart(2, "0")} Living`, type: "living", r: { x0: hx1, y0: yA, x1, y1: midY }, zone: `uR${i}` },
            { id: `${prefix}-uR${i}bed`, name: `Unit G${String(unitNo).padStart(2, "0")} Bedroom`, type: "bedroom", r: { x0: hx1, y0: midY, x1, y1: yB }, zone: `uR${i}` },
          );
          unitNo++;
        }
      }
    } else {
      const edges = depthEdges(y0, y1, unitRows);
      let unitNo = 1;
      for (let i = 0; i < unitRows; i++) {
        const yA = edges[i], yB = edges[i + 1];
        if (yB - yA < 2.0) continue;
        if (kind === "apartments") {
          const midY = (yA + yB) / 2;
          rooms.push(
            { id: `${prefix}-uL${i}liv`, name: `Unit ${lv + 1}${String(unitNo).padStart(2, "0")} Living`, type: "living", r: { x0, y0: yA, x1: hx0, y1: midY }, zone: `uL${i}` },
            { id: `${prefix}-uL${i}bed`, name: `Unit ${lv + 1}${String(unitNo).padStart(2, "0")} Bedroom`, type: "bedroom", r: { x0, y0: midY, x1: hx0, y1: yB }, zone: `uL${i}` },
          );
          unitNo++;
          rooms.push(
            { id: `${prefix}-uR${i}liv`, name: `Unit ${lv + 1}${String(unitNo).padStart(2, "0")} Living`, type: "living", r: { x0: hx1, y0: yA, x1, y1: midY }, zone: `uR${i}` },
            { id: `${prefix}-uR${i}bed`, name: `Unit ${lv + 1}${String(unitNo).padStart(2, "0")} Bedroom`, type: "bedroom", r: { x0: hx1, y0: midY, x1, y1: yB }, zone: `uR${i}` },
          );
          unitNo++;
        } else if (kind === "hospital") {
          rooms.push({
            id: `${prefix}-pL${i}`,
            name: `Patient ${lv + 1}${String(unitNo).padStart(2, "0")}`,
            type: "bedroom",
            r: { x0, y0: yA, x1: hx0, y1: yB },
            zone: `pL${i}`,
          });
          unitNo++;
          rooms.push({
            id: `${prefix}-pR${i}`,
            name: `Patient ${lv + 1}${String(unitNo).padStart(2, "0")}`,
            type: "bedroom",
            r: { x0: hx1, y0: yA, x1, y1: yB },
            zone: `pR${i}`,
          });
          unitNo++;
        } else {
          const label = kind === "hotel" ? "Guest" : "Room";
          rooms.push({
            id: `${prefix}-rL${i}`,
            name: `${label} ${lv + 1}${String(unitNo).padStart(2, "0")}`,
            type: "bedroom",
            r: { x0, y0: yA, x1: hx0, y1: yB },
            zone: `rL${i}`,
          });
          unitNo++;
          rooms.push({
            id: `${prefix}-rR${i}`,
            name: `${label} ${lv + 1}${String(unitNo).padStart(2, "0")}`,
            type: "bedroom",
            r: { x0: hx1, y0: yA, x1, y1: yB },
            zone: `rR${i}`,
          });
          unitNo++;
        }
      }
      // Corridor carved around end-of-hall pods so walls don't span through nested rooms.
      if (kind === "dormitory") {
        const bathY0 = y1 - 3.0;
        rooms.push(
          { id: `${prefix}-hall`, name: "Corridor", type: "hallway", r: { x0: hx0, y0, x1: hx1, y1: bathY0 }, zone: "hall" },
          { id: `${prefix}-bath`, name: "Shared Bath", type: "bathroom", r: { x0: hx0, y0: bathY0, x1: hx1, y1 }, zone: "bath" },
        );
      } else if (kind === "hotel") {
        const svcY0 = y1 - 2.8;
        rooms.push(
          { id: `${prefix}-hall`, name: "Corridor", type: "hallway", r: { x0: hx0, y0, x1: hx1, y1: svcY0 }, zone: "hall" },
          { id: `${prefix}-svc`, name: "Service / Linen", type: "utility", r: { x0: hx0, y0: svcY0, x1: hx1, y1 }, zone: "svc" },
        );
      } else if (kind === "hospital") {
        const nurseY1 = y0 + Math.min(4, D * 0.12);
        rooms.push(
          { id: `${prefix}-nurse`, name: "Nurse Station", type: "office", r: { x0: hx0, y0: y0 + 1, x1: hx1, y1: nurseY1 }, zone: "nurse" },
          { id: `${prefix}-hall`, name: "Corridor", type: "hallway", r: { x0: hx0, y0: nurseY1, x1: hx1, y1 }, zone: "hall" },
        );
      } else {
        rooms.push({ id: `${prefix}-hall`, name: "Corridor", type: "hallway", r: { x0: hx0, y0, x1: hx1, y1 }, zone: "hall" });
      }
    }

    floors.push({ level: lv, rooms, stair });
  }

  const label =
    kind === "dormitory"
      ? "Dormitory-style layout: amenity ground floor (lounge, laundry, study) and bedroom floors above"
      : kind === "apartments"
        ? "Apartment-style layout: lobby/mail on the ground floor and unit pads on floors above"
        : kind === "hotel"
          ? "Hotel-style layout: lobby/restaurant/meeting on the ground floor and guest-room floors above"
          : "Hospital-style layout: admitting/ED/clinic on the ground floor and patient wards above";
  notes.push(`${label}. Estimated program plan, not a measured survey.`);
  return floors;
}
