/**
 * Tiny process-local TTL cache (survives across requests on a warm serverless instance,
 * lost on cold start). Used to skip repeat OSM / DEM round-trips for the same place.
 */

type Entry<T> = { value: T; exp: number };

type Bucket<T> = Map<string, Entry<T>>;

const HOUR_MS = 60 * 60 * 1000;

function bucket<T>(ns: string): Bucket<T> {
  const g = globalThis as unknown as Record<string, Bucket<T> | undefined>;
  const key = `__cloudscanTtl_${ns}`;
  return (g[key] ??= new Map());
}

/** Round lat/lng to ~55 m cells so nearby rescan hits share a key. */
export function geoCacheKey(lat: number, lng: number, decimals = 3): string {
  return `${lat.toFixed(decimals)},${lng.toFixed(decimals)}`;
}

export function ttlGet<T>(ns: string, key: string): T | undefined {
  const map = bucket<T>(ns);
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

export function ttlSet<T>(ns: string, key: string, value: T, ttlMs = HOUR_MS, maxEntries = 120): void {
  const map = bucket<T>(ns);
  map.set(key, { value, exp: Date.now() + ttlMs });
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
