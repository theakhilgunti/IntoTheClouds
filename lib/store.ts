/**
 * Saved scans. One interface so the backend can be swapped without touching the pipeline or UI.
 *
 * TODO(backend): replace `memoryStore` with a MongoDB Atlas implementation of `ScanStore`
 * (collection `scans`, _id = model.id). Keys are building IDs ("osm-<wayId>"), so the same
 * house always maps to the same document no matter how the address was typed.
 *
 * Until then: scans are cached in server memory (lost on redeploy / cold start) and the
 * browser keeps its own copy in localStorage, so reopening a house costs nothing.
 */
import type { ScanResult } from "./sources";

export interface ScanStore {
  get(id: string): Promise<ScanResult | null>;
  put(result: ScanResult): Promise<void>;
}

const g = globalThis as unknown as { __cloudscanMem?: Map<string, ScanResult> };
const mem = (g.__cloudscanMem ??= new Map());

export const memoryStore: ScanStore = {
  async get(id) {
    return mem.get(id) ?? null;
  },
  async put(result) {
    mem.set(result.model.id, result);
    if (mem.size > 500) mem.delete(mem.keys().next().value!);
  },
};

export const store: ScanStore = memoryStore;
