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

function isSvgFile(file: File): boolean {
  const n = file.name.toLowerCase();
  return n.endsWith(".svg") || file.type === "image/svg+xml" || file.type === "text/xml";
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
      const form = new FormData();
      if (isSvgFile(file)) {
        form.append("file", file, file.name.endsWith(".svg") ? file.name : "plan.svg");
      } else {
        const blob = await shrink(file);
        form.append("file", new File([blob], "plan.jpg", { type: "image/jpeg" }));
      }
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
      setProblems([
        "Couldn't read that file. Use a CubiCasa / CubiCasa5K SVG, or a clear photo of the floor plan (JPEG, PNG or WebP).",
      ]);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mt-3 border-t border-bp-ink/30 pt-3">
      <div className="font-data text-xs text-bp-red">Have a real floor plan? Add it to make this floor verified.</div>
      <p className="mt-1 text-xs text-bp-line">
        Best: CubiCasa / CubiCasa5K SVG (vector rooms). Or a clear photo — AI reads rooms only if they are drawn.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          className="min-h-9 border border-bp-ink/45 bg-bp-deep px-2 font-data text-xs text-bp-ink"
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
          className="min-h-9 border border-bp-ink bg-bp-ink px-3 font-data text-xs uppercase text-bp hover:bg-transparent hover:text-bp-ink disabled:opacity-60"
        >
          {busy ? "Reading plan…" : "Upload floor plan"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml,.svg"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>
      {problems.length > 0 && (
        <div className="mt-2 border border-dashed border-bp-red p-2 text-xs text-bp-red">
          <div className="font-black">This plan was not used. Why:</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {done && (
        <div className="mt-2 border border-bp-ink p-2 text-xs text-bp-ink">
          Plan added. Compare the 3D rooms with your source.
          {done.map((n) => (
            <div key={n} className="mt-1 text-bp-red">
              • {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
