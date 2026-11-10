/**
 * Clean facade maps for terrain-style realistic mode (Street View / Gemini material cues).
 * Soft, low-contrast patterns — no satellite draping.
 */
import * as THREE from "three";
import type { FacadePreset } from "@/packages/schema/building-model";

const facadeCache = new Map<FacadePreset, THREE.CanvasTexture>();

function makeCanvas(size = 512): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

/** Soft seed noise — deterministic, no Math.random flicker across remounts. */
function hashNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function fillBase(ctx: CanvasRenderingContext2D, size: number, hex: string) {
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size);
}

function softGrain(ctx: CanvasRenderingContext2D, size: number, strength = 0.045) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const n = (hashNoise(x, y) - 0.5) * strength * 255;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y + dy) * size + (x + dx)) * 4;
          d[i] = Math.min(255, Math.max(0, d[i] + n));
          d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
          d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function faintCourses(ctx: CanvasRenderingContext2D, size: number, color: string, step: number, alpha = 0.12) {
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1;
  for (let y = step; y < size; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function paintBrick(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#a56b5c");
  softGrain(ctx, size, 0.05);
  // Soft mortar courses only — no loud brick grid.
  faintCourses(ctx, size, "#c9b2a6", size / 14, 0.14);
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = "#c9b2a6";
  const bw = size / 6;
  const bh = size / 14;
  for (let row = 0; row < 14; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col < 7; col++) {
      ctx.strokeRect(col * bw + off + 1, row * bh + 1, bw - 2, bh - 2);
    }
  }
  ctx.globalAlpha = 1;
}

function paintVinyl(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#e6e2da");
  softGrain(ctx, size, 0.03);
  faintCourses(ctx, size, "#d0cbc1", size / 12, 0.18);
}

function paintStucco(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#d6cfc3");
  softGrain(ctx, size, 0.07);
}

function paintWood(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#b89272");
  softGrain(ctx, size, 0.04);
  faintCourses(ctx, size, "#9a7558", size / 10, 0.16);
}

function paintConcrete(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#b4b2ae");
  softGrain(ctx, size, 0.055);
  // Soft panel joints — institutional / dorm look.
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = "#8e8c88";
  ctx.lineWidth = 2;
  ctx.strokeRect(size * 0.02, size * 0.02, size * 0.46, size * 0.46);
  ctx.strokeRect(size * 0.52, size * 0.02, size * 0.46, size * 0.46);
  ctx.strokeRect(size * 0.02, size * 0.52, size * 0.46, size * 0.46);
  ctx.strokeRect(size * 0.52, size * 0.52, size * 0.46, size * 0.46);
  ctx.globalAlpha = 1;
}

function paintUnknown(ctx: CanvasRenderingContext2D, size: number) {
  fillBase(ctx, size, "#c5c2bb");
  softGrain(ctx, size, 0.04);
}

const PAINTERS: Record<FacadePreset, (ctx: CanvasRenderingContext2D, size: number) => void> = {
  brick: paintBrick,
  vinyl: paintVinyl,
  stucco: paintStucco,
  wood: paintWood,
  concrete: paintConcrete,
  unknown: paintUnknown,
};

/** Shared repeating facade map for a preset (cached). */
export function facadeTexture(preset: FacadePreset): THREE.CanvasTexture {
  const hit = facadeCache.get(preset);
  if (hit) return hit;
  const size = 512;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  PAINTERS[preset](ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  facadeCache.set(preset, tex);
  return tex;
}

/** Flat facade tint used with subtle maps so large halls stay clean. */
export const FACADE_TINT: Record<FacadePreset, string> = {
  brick: "#c48a7a",
  vinyl: "#ebe7e0",
  stucco: "#ddd6ca",
  wood: "#c4a084",
  concrete: "#c0beba",
  unknown: "#ccc9c2",
};
