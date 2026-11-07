"use client";

import { useRef, useState } from "react";
import type { BuildingModel, Point } from "@/packages/schema/building-model";

const LEVEL_NAMES: Record<number, string> = { [-1]: "Basement", 0: "1st Floor", 1: "2nd Floor", 2: "3rd Floor" };

/** Shrink a plan photo so it fits the server's request limit and uploads fast. */
async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.88));
}

export default function FloorPlanPanel({
  model,
  streetDir,
  onApplied,
}: {
  model: BuildingModel;
  streetDir: Point | null;
  onApplied: (m: BuildingModel) => void;
}) {
  const levels = [...new Set([...model.floors.map((f) => f.level), -1])].sort((a, b) => a - b);
  const firstMissing = model.floors.find((f) => f.rooms.length === 0)?.level ?? levels[0];
  const [level, setLevel] = useState(firstMissing);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setProblems([]);
    setDone(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.append("file", new File([blob], "plan.jpg", { type: "image/jpeg" }));
      form.append("model", JSON.stringify(model));
      form.append("level", String(level));
      form.append("streetDir", JSON.stringify(streetDir));
      const res = await fetch("/api/floorplan", { method: "POST", body: form });
      const out = await res.json();
      if (out.ok) {
        onApplied(out.model as BuildingModel);
        setDone(out.notes as string[]);
      } else {
        setProblems((out.reasons as string[]) ?? ["The plan could not be used."]);
      }
    } catch {
      setProblems(["Couldn't read that file. Use a clear photo or screenshot of the floor plan (JPEG, PNG or WebP)."]);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mt-3 border-t border-neutral-700 pt-3">
      <div className="text-xs font-bold text-yellow-300">Have a floor plan? Add it to make this floor real.</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          className="min-h-9 rounded-lg bg-neutral-800 px-2 text-xs font-semibold text-white"
          aria-label="Which floor is this plan for?"
        >
          {levels.map((l) => (
            <option key={l} value={l}>
              {model.floors.find((f) => f.level === l)?.name ?? LEVEL_NAMES[l] ?? `Level ${l}`}
            </option>
          ))}
        </select>
        <button
          disabled={busy}
          onClick={() => input.current?.click()}
          className="min-h-9 rounded-lg bg-yellow-400 px-3 text-xs font-black uppercase text-black hover:bg-yellow-300 disabled:opacity-60"
        >
          {busy ? "Reading plan…" : "Upload floor plan"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>
      {problems.length > 0 && (
        <div className="mt-2 rounded-lg border border-red-500 bg-red-950/60 p-2 text-xs text-red-200">
          <div className="font-black">This plan was not used. Why:</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {done && (
        <div className="mt-2 rounded-lg border border-emerald-600 bg-emerald-950/60 p-2 text-xs text-emerald-200">
          Plan added. It was read by AI, so compare the 3D rooms with your plan.
          {done.map((n) => (
            <div key={n} className="mt-1 text-amber-200">• {n}</div>
          ))}
        </div>
      )}
    </div>
  );
}
