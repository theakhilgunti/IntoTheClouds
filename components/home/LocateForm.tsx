"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveScan, recentScans, type SavedScan, type ScanQuery } from "@/lib/clientStore";
import { streamScan } from "@/lib/scanClient";
import { STEP_LABELS, type StepKey } from "@/lib/sources";

type Mode = "photo" | "address";
type StepState = { status: "pending" | "active" | "done" | "skipped"; detail?: string };
const STEPS = Object.keys(STEP_LABELS) as StepKey[];
const EXAMPLES = ["17 Schuyler Ave, Latham, NY 12110", "45 Brunswick Rd, Troy, NY 12180"];

/** Shrink a photo to <= maxSide px JPEG (keeps uploads small and fast). */
async function shrink(file: File, maxSide: number, quality: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("encode"))), "image/jpeg", quality));
}

const toDataUrl = (b: Blob) =>
  new Promise<string>((ok) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.readAsDataURL(b);
  });

async function photoLocation(file: File): Promise<{ lat: number; lng: number; heading?: number } | null> {
  try {
    const exifr = (await import("exifr")).default;
    const gps = await exifr.gps(file);
    if (!gps?.latitude || !gps?.longitude) return null;
    const dir = await exifr.parse(file, ["GPSImgDirection"]).catch(() => null);
    return { lat: gps.latitude, lng: gps.longitude, heading: dir?.GPSImgDirection };
  } catch {
    return null;
  }
}

function deviceLocation(): Promise<{ lat: number; lng: number; heading?: number } | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, heading: p.coords.heading ?? undefined }),
      () => ok(null),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

export default function LocateForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("address");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Record<StepKey, StepState> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<SavedScan[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setRecent(recentScans()), []);

  function pickFile(f: File | undefined) {
    if (!f || !f.type.startsWith("image/")) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setError(null);
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const ready = mode === "photo" ? !!file : address.trim().length > 5;

  async function submit(e?: React.FormEvent, overrideAddress?: string) {
    e?.preventDefault();
    const addr = (overrideAddress ?? address).trim();
    if (busy) return;
    if (!overrideAddress && !ready) {
      setError(mode === "photo" ? "Add a photo of the house first." : "Type the full street address, with city and state.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    setSteps(Object.fromEntries(STEPS.map((k) => [k, { status: "pending" }])) as Record<StepKey, StepState>);

    const form = new FormData();
    const query: ScanQuery = {};
    let thumb: string | undefined;
    try {
      if (mode === "photo" && file && !overrideAddress) {
        try {
          form.append("photo", await shrink(file, 1280, 0.82), "house.jpg");
          thumb = await toDataUrl(await shrink(file, 360, 0.7));
        } catch {
          throw new Error("This photo format can't be read here. Try a JPG or PNG, or take the photo with your camera.");
        }
        if (addr) {
          form.append("address", addr);
          query.address = addr;
        } else {
          let loc = await photoLocation(file);
          if (!loc) {
            setNote("Your photo has no location tag, so we're using your current location. Stand near the house.");
            loc = await deviceLocation();
          }
          if (!loc) {
            throw new Error("We couldn't tell where this photo was taken. Add the address below the photo and try again.");
          }
          form.append("lat", String(loc.lat));
          form.append("lng", String(loc.lng));
          if (loc.heading != null) form.append("heading", String(loc.heading));
          Object.assign(query, { lat: loc.lat, lng: loc.lng });
        }
      } else {
        form.append("address", addr);
        query.address = addr;
      }

      const { result } = await streamScan(form, (ev) => {
        if (ev.type === "step") {
          setSteps((s) => (s ? { ...s, [ev.key]: { status: ev.status, detail: ev.detail } } : s));
        }
      });
      saveScan({ result, query, photo: thumb });
      router.push(`/model/${encodeURIComponent(result.model.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
      setSteps(null);
    }
  }

  return (
    <div className="w-full max-w-xl space-y-4">
      <form
        onSubmit={submit}
        className="rounded-2xl border border-white/10 bg-neutral-900/80 p-3 shadow-[0_0_80px_-20px_rgba(250,204,21,0.35)] backdrop-blur"
      >
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-black/50 p-1">
          {(["address", "photo"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={busy}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`min-h-11 rounded-lg px-4 text-sm font-bold uppercase tracking-wider transition ${
                mode === m ? "bg-yellow-400 text-black" : "text-neutral-400 hover:text-white"
              }`}
            >
              {m === "photo" ? "Photo" : "Address"}
            </button>
          ))}
        </div>

        <div className="p-3 pt-4 text-left">
          {steps ? (
            <ol className="flex min-h-56 flex-col justify-center gap-3" aria-live="polite">
              {STEPS.map((k) => {
                const s = steps[k];
                return (
                  <li key={k} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                      {s.status === "active" ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-yellow-400/30 border-t-yellow-400" />
                      ) : s.status === "done" ? (
                        <span className="text-yellow-400">✓</span>
                      ) : s.status === "skipped" ? (
                        <span className="text-neutral-500">–</span>
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
                      )}
                    </span>
                    <span>
                      <span className={s.status === "pending" ? "text-neutral-500" : "text-white"}>{STEP_LABELS[k]}</span>
                      {s.detail && <span className="block text-sm text-neutral-400">{s.detail}</span>}
                    </span>
                  </li>
                );
              })}
              {note && <li className="text-sm text-yellow-300/90">{note}</li>}
            </ol>
          ) : mode === "photo" ? (
            <div className="space-y-3">
              {preview ? (
                <div className="relative overflow-hidden rounded-xl border border-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={preview} alt="Selected house" className="h-48 w-full object-cover" />
                  <button
                    type="button"
                    onClick={clearFile}
                    className="absolute right-2 top-2 rounded-md bg-black/70 px-3 py-1 text-xs font-bold uppercase text-white hover:bg-black"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <label
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    pickFile(e.dataTransfer.files[0]);
                  }}
                  className={`flex h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center transition ${
                    dragging ? "border-yellow-400 bg-yellow-400/10" : "border-white/20 hover:border-yellow-400/60 hover:bg-white/[0.03]"
                  }`}
                >
                  <svg aria-hidden width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-yellow-400">
                    <path d="M3 10.5 12 3l9 7.5V21H3z" />
                    <path d="M9 21v-6h6v6" />
                  </svg>
                  <span className="text-lg font-semibold text-white">Take or upload a photo of the house</span>
                  <span className="text-sm text-neutral-400">Front of the building works best</span>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                </label>
              )}
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Address (optional, if the photo has no location)"
                autoComplete="street-address"
                className="min-h-12 w-full rounded-xl border border-white/15 bg-black/60 px-4 text-white placeholder:text-neutral-600 focus:border-yellow-400 focus:outline-none focus:ring-2 focus:ring-yellow-400/30"
              />
            </div>
          ) : (
            <div className="flex min-h-48 flex-col justify-center gap-3">
              <label htmlFor="addr" className="text-sm font-semibold text-neutral-300">
                Street address of the house
              </label>
              <input
                id="addr"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError(null);
                }}
                placeholder="17 Schuyler Ave, Latham, NY 12110"
                autoComplete="street-address"
                className="min-h-14 w-full rounded-xl border border-white/15 bg-black/60 px-4 text-lg text-white placeholder:text-neutral-600 focus:border-yellow-400 focus:outline-none focus:ring-2 focus:ring-yellow-400/30"
              />
              <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-500">
                Try:
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      setAddress(ex);
                      setError(null);
                    }}
                    className="rounded-full border border-white/10 px-3 py-1 text-neutral-300 hover:border-yellow-400/50 hover:text-white"
                  >
                    {ex.split(",").slice(0, 2).join(",")}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-4 flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-yellow-400 text-lg font-black uppercase tracking-wider text-black transition hover:bg-yellow-300 disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? "Scanning…" : "Generate 3D model →"}
          </button>
        </div>
      </form>

      {recent.length > 0 && !busy && (
        <div className="text-left">
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-neutral-500">Your recent scans</p>
          <div className="flex flex-wrap gap-2">
            {recent.slice(0, 4).map((s) => (
              <a
                key={s.result.model.id}
                href={`/model/${encodeURIComponent(s.result.model.id)}`}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-300 hover:border-yellow-400/50 hover:text-white"
              >
                {s.result.model.address || "Scanned house"}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
