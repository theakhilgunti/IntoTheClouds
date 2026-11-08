"use client";
/**
 * Browser-side copy of each scan, so reopening a house is instant and free even before the
 * shared backend exists. Every access is wrapped: storage can be full, blocked or private.
 *
 * Saved houses last for one browser session only — a new tab/session starts with an empty list.
 */
import type { ScanResult } from "./sources";

export type ScanQuery = { address?: string; lat?: number; lng?: number };
export type SavedScan = { result: ScanResult; query: ScanQuery; photo?: string };

const KEY = (id: string) => `cloudscan:scan:${id}`;
const INDEX = "cloudscan:recent";
const SESSION = "cloudscan:session";
const MAX = 12;

function readIndex(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? "[]");
  } catch {
    return [];
  }
}

/** Drop every cached scan + the recent index. */
export function clearSavedScans() {
  try {
    for (const id of readIndex()) localStorage.removeItem(KEY(id));
    localStorage.removeItem(INDEX);
  } catch {
    /* storage unavailable */
  }
}

/**
 * On the first touch of a browser session, wipe last session's saved houses.
 * Same-tab reloads keep the list via sessionStorage.
 */
export function ensureSessionScans() {
  try {
    if (typeof sessionStorage === "undefined" || typeof localStorage === "undefined") return;
    if (sessionStorage.getItem(SESSION)) return;
    clearSavedScans();
    sessionStorage.setItem(SESSION, "1");
  } catch {
    /* private mode / blocked storage */
  }
}

export function saveScan(scan: SavedScan) {
  ensureSessionScans();
  const id = scan.result.model.id;
  const ids = [id, ...readIndex().filter((x) => x !== id)];
  const write = (s: SavedScan) => localStorage.setItem(KEY(id), JSON.stringify(s));
  try {
    try {
      write(scan);
    } catch {
      // Storage full: drop the oldest scans, then try again without images.
      for (const old of ids.slice(MAX / 2)) localStorage.removeItem(KEY(old));
      ids.length = Math.min(ids.length, MAX / 2);
      write({ ...scan, photo: undefined, result: { ...scan.result, images: [] } });
    }
    for (const old of ids.slice(MAX)) localStorage.removeItem(KEY(old));
    localStorage.setItem(INDEX, JSON.stringify(ids.slice(0, MAX)));
  } catch {
    /* storage unavailable; the scan still opens from this session's navigation */
  }
}

export function loadScan(id: string): SavedScan | null {
  ensureSessionScans();
  try {
    const raw = localStorage.getItem(KEY(id));
    return raw ? (JSON.parse(raw) as SavedScan) : null;
  } catch {
    return null;
  }
}

export function recentScans(): SavedScan[] {
  ensureSessionScans();
  return readIndex()
    .map(loadScan)
    .filter((s): s is SavedScan => !!s);
}
