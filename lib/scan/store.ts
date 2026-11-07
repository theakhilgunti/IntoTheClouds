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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScanResult } from "@/lib/scan/sources";

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

/**
 * Local development: also keep scans on disk (.data/, git-ignored) so a LiDAR upload survives a server
 * restart. On Vercel the disk is read-only and temporary, so there it stays memory-only until the
 * shared database lands.
 */
const DIR = path.join(process.cwd(), ".data", "scans");
const useDisk = !process.env.VERCEL;
const file = (id: string) => path.join(DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

export const fileStore: ScanStore = {
  async get(id) {
    const hit = await memoryStore.get(id);
    if (hit) return hit;
    try {
      const r = JSON.parse(await readFile(file(id), "utf8")) as ScanResult;
      await memoryStore.put(r);
      return r;
    } catch {
      return null;
    }
  },
  async put(result) {
    await memoryStore.put(result);
    try {
      await mkdir(DIR, { recursive: true });
      await writeFile(file(result.model.id), JSON.stringify(result));
    } catch (e) {
      console.error("could not save scan to disk", e);
    }
  },
};

export const store: ScanStore = useDisk ? fileStore : memoryStore;
