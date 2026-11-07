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

export function streetsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const words = (s: string) => s.split(" ").filter((w) => w && !STREET_SUFFIX.has(w));
  const ta = words(a);
  const tb = words(b);
  if (!ta.length || !tb.length) return false;
  return ta.every((w) => tb.includes(w)) || tb.every((w) => ta.includes(w));
}
