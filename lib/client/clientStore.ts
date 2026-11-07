"use client";
/**
 * Browser-side copy of each scan, so reopening a house is instant and free even before the
 * shared backend exists. Every access is wrapped: storage can be full, blocked or private.
 */
import type { ScanResult } from "@/lib/scan/sources";

export type ScanQuery = { address?: string; lat?: number; lng?: number };
export type SavedScan = { result: ScanResult; query: ScanQuery; photo?: string };

const KEY = (id: string) => `cloudscan:scan:${id}`;
const INDEX = "cloudscan:recent";
const MAX = 12;

function readIndex(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? "[]");
  } catch {
    return [];
  }
}

export function saveScan(scan: SavedScan) {
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
  try {
    const raw = localStorage.getItem(KEY(id));
    return raw ? (JSON.parse(raw) as SavedScan) : null;
  } catch {
    return null;
  }
}

export function recentScans(): SavedScan[] {
  return readIndex()
    .map(loadScan)
    .filter((s): s is SavedScan => !!s);
}
