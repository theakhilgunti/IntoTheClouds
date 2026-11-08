const STREET_WORDS: Record<string, string> = {
  avenue: "ave", street: "st", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd",
  place: "pl", circle: "cir", terrace: "ter", highway: "hwy", parkway: "pkwy", north: "n", south: "s", east: "e", west: "w",
};
const STREET_SUFFIX = new Set(Object.values(STREET_WORDS));

export const normStreet = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => STREET_WORDS[w] ?? w).join(" ");

/** "17 SCHUYLER AVE, LATHAM, NY" or "213, Simonson Avenue, Elm Park, ..." -> number + street. */
export function parseStreetAddress(a?: string | null): { num: string; street: string } | null {
  if (!a) return null;
  const commaForm = a.trim().match(/^(\d+[a-z]?)\s*,\s*([^,]+)/i);
  if (commaForm) return { num: commaForm[1].toLowerCase(), street: normStreet(commaForm[2]) };
  const line = a.split(",")[0].trim().match(/^(\d+[a-z]?)\s+(.+)$/i);
  return line ? { num: line[1].toLowerCase(), street: normStreet(line[2]) } : null;
}

/**
 * Street name from a full address or a street-only geocode label like
 * "Yardley Court, East Goshen Township, PA" (no house number).
 */
export function parseStreetName(a?: string | null): string | null {
  const full = parseStreetAddress(a);
  if (full) return full.street;
  if (!a) return null;
  const head = a.split(",")[0]?.trim();
  if (!head || /^\d/.test(head)) return null;
  const n = normStreet(head);
  return n || null;
}

const PLUTO_SUFFIX: Record<string, string> = {
  ave: "AVENUE", st: "STREET", rd: "ROAD", dr: "DRIVE", ln: "LANE", ct: "COURT", blvd: "BOULEVARD",
  pl: "PLACE", cir: "CIRCLE", ter: "TERRACE", hwy: "HIGHWAY", pkwy: "PARKWAY",
};

/** NYC MapPLUTO spells the street in full, e.g. "213 SIMONSON AVENUE". */
export function plutoAddress(a?: string | null): string | null {
  const p = parseStreetAddress(a);
  if (!p) return null;
  const parts = p.street.split(" ");
  const last = parts.pop();
  if (!last) return null;
  const suffix = PLUTO_SUFFIX[last] ?? last.toUpperCase();
  return `${p.num.toUpperCase()} ${[...parts.map((w) => w.toUpperCase()), suffix].join(" ")}`;
}

function streetSuffix(s: string): string | null {
  const parts = s.split(" ").filter(Boolean);
  const last = parts[parts.length - 1];
  return last && STREET_SUFFIX.has(last) ? last : null;
}

/**
 * True when two normalized street names refer to the same road.
 * Stem-only names still match a full name (`yardley` ≈ `yardley ct`), but when both
 * sides carry a suffix they must agree (`yardley ct` ≠ `yardley dr`).
 */
export function streetsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = streetSuffix(a);
  const sb = streetSuffix(b);
  if (sa && sb && sa !== sb) return false;
  const words = (s: string) => s.split(" ").filter((w) => w && !STREET_SUFFIX.has(w));
  const ta = words(a);
  const tb = words(b);
  if (!ta.length || !tb.length) return false;
  return ta.every((w) => tb.includes(w)) || tb.every((w) => ta.includes(w));
}

/** How much farther than the nearest curb an address street may still win (meters). */
export const PREFER_STREET_SLACK_M = 15;
