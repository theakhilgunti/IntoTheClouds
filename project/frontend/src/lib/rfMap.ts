import { RFMapResponse } from '../types';

export const RF_MIN_DBM = -90;
export const RF_MAX_DBM = -40;
export const ALL_ANCHORS = 'all';

export interface RFCell {
  x: number; // backend metres (cell centre)
  y: number;
  dbm: number;
}

/** 0 (weak) .. 1 (strong), clamped to the fixed -90..-40 dBm range. */
export function dbmToT(dbm: number): number {
  const t = (dbm - RF_MIN_DBM) / (RF_MAX_DBM - RF_MIN_DBM);
  return Math.min(1, Math.max(0, t));
}

/** Cool blue (weak) to warm red (strong) via hue 240 -> 0. Returns [r,g,b] in 0..1. */
export function dbmToRgb(dbm: number): [number, number, number] {
  const h = (1 - dbmToT(dbm)) * 240 / 60; // 0..4 sector index
  const c = 1;
  const x = 1 - Math.abs((h % 2) - 1);
  const sector = Math.min(4, Math.floor(h));
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [0, 0, c],
  ];
  return table[sector];
}

/** CSS gradient for the legend (strong on the right). */
export const RF_LEGEND_GRADIENT = 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)';

/** Flatten the map into non-null cells; 'all' takes the strongest value per cell. */
export function collectCells(map: RFMapResponse | null, selected: string): RFCell[] {
  if (!map) return [];
  const ids = selected === ALL_ANCHORS ? Object.keys(map.cells) : map.cells[selected] ? [selected] : [];
  const best = new Map<number, number>();
  for (const id of ids) {
    const rows = map.cells[id];
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const key = j * 100000 + i;
        const prev = best.get(key);
        if (prev === undefined || v > prev) best.set(key, v);
      }
    }
  }
  const out: RFCell[] = [];
  best.forEach((dbm, key) => {
    const j = Math.floor(key / 100000);
    const i = key % 100000;
    out.push({
      x: map.bounds.min_x + (i + 0.5) * map.cell_m,
      y: map.bounds.min_y + (j + 0.5) * map.cell_m,
      dbm,
    });
  });
  return out;
}
