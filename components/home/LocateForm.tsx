"use client";

import { useEffect, useRef, useState } from "react";
import { useSheetNav } from "@/components/ui/SheetTransition";
import { saveScan, recentScans, type SavedScan, type ScanQuery } from "@/lib/clientStore";
import { streamScan } from "@/lib/scanClient";
import { STEP_LABELS, type StepKey } from "@/lib/sources";

type Mode = "photo" | "address";
type StepState = { status: "pending" | "active" | "done" | "skipped"; detail?: string };
const STEPS = Object.keys(STEP_LABELS) as StepKey[];
const EXAMPLE = "17 Schuyler Ave, Latham, NY 12110";

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
  const go = useSheetNav();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [address, setAddress] = useState("");
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

  const mode: Mode = file ? "photo" : "address";
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
      go(`/model/${encodeURIComponent(result.model.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
      setSteps(null);
    }
  }

  return (
    <div className="w-full max-w-[440px] space-y-3 text-left">
      {steps ? (
        <ol className="space-y-3 border border-bp-ink/60 bg-bp-deep/80 p-5 font-data text-sm" aria-live="polite">
          {STEPS.map((k) => {
            const s = steps[k];
            return (
              <li key={k} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  {s.status === "active" ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-bp-ink/30 border-t-bp-red" />
                  ) : s.status === "done" ? (
                    <span className="text-bp-red">✓</span>
                  ) : s.status === "skipped" ? (
                    <span className="text-bp-line">–</span>
                  ) : (
                    <span className="h-1.5 w-1.5 bg-bp-line/60" />
                  )}
                </span>
                <span>
                  <span className={s.status === "pending" ? "text-bp-line" : "text-bp-ink"}>{STEP_LABELS[k]}</span>
                  {s.detail && <span className="block text-xs text-bp-line">{s.detail}</span>}
                </span>
              </li>
            );
          })}
          {note && <li className="text-xs text-bp-red">{note}</li>}
        </ol>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="flex bg-bp-ink text-bp">
            <label htmlFor="addr" className="sr-only">
              Street address of the house
            </label>
            <input
              id="addr"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
              placeholder={file ? "Address (optional)" : "Enter an address"}
              autoComplete="street-address"
              className="min-h-12 min-w-0 flex-1 bg-transparent px-4 font-data text-sm text-bp placeholder:text-bp/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bp-red"
            />
            <button
              type="submit"
              disabled={busy}
              className="min-h-12 bg-bp-red px-6 font-data text-sm text-bp transition hover:bg-white disabled:cursor-wait disabled:opacity-70"
            >
              Scan
            </button>
          </div>

          <div className="flex items-center gap-3 font-data text-[11px] text-bp-line" aria-hidden>
            <span className="h-px flex-1 bg-bp-ink/40" />
            or
            <span className="h-px flex-1 bg-bp-ink/40" />
          </div>

          {preview ? (
            <div className="flex items-center gap-3 border border-bp-ink p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Selected house" className="h-12 w-16 object-cover" />
              <span className="min-w-0 flex-1 truncate font-data text-xs">{file?.name}</span>
              <button
                type="button"
                onClick={clearFile}
                className="px-3 py-2 font-data text-xs underline underline-offset-4 hover:text-bp-red"
              >
                Remove
              </button>
            </div>
          ) : (
            <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 border border-dashed border-bp-ink font-data text-sm transition hover:bg-bp-ink/10 focus-within:ring-2 focus-within:ring-bp-red">
              <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Upload a photo
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

          {error && (
            <p role="alert" className="border border-bp-red px-3 py-2 font-data text-xs text-bp-red">
              {error}
            </p>
          )}

          {!file && !address && (
            <button
              type="button"
              onClick={() => setAddress(EXAMPLE)}
              className="block w-full text-center font-data text-[11px] text-bp-line underline underline-offset-4 hover:text-bp-ink"
            >
              Try {EXAMPLE.split(",")[0]}
            </button>
          )}
        </form>
      )}

      {recent.length > 0 && !busy && (
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {recent.slice(0, 3).map((s) => (
            <a
              key={s.result.model.id}
              href={`/model/${encodeURIComponent(s.result.model.id)}`}
              className="border border-bp-ink/40 px-3 py-1.5 font-data text-[11px] text-bp-line hover:border-bp-ink hover:text-bp-ink"
            >
              {s.result.model.address || "Scanned house"}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
