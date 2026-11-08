"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSheetNav } from "@/components/ui/SheetTransition";
import { saveScan, recentScans, type SavedScan, type ScanQuery } from "@/lib/clientStore";
import { isHeicFile, isImageUpload, toJpegFile } from "@/lib/heic";
import { streamScan } from "@/lib/scanClient";
import { STEP_LABELS, type StepKey } from "@/lib/sources";

type Mode = "photo" | "address";
type StepState = { status: "pending" | "active" | "done" | "skipped"; detail?: string };
type Suggestion = {
  label: string;
  primary: string;
  secondary: string;
  lat: number;
  lng: number;
  wayId?: number | null;
};

const STEPS = Object.keys(STEP_LABELS) as StepKey[];
const EXAMPLE = "Burdett Avenue Residence Hall, Troy, NY";

/** Shrink a photo to <= maxSide px JPEG (keeps uploads small and fast). HEIC is decoded first. */
async function shrink(file: File, maxSide: number, quality: number): Promise<Blob> {
  const raster = await toJpegFile(file);
  const bmp = await createImageBitmap(raster);
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
  const listId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Record<StepKey, StepState> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<SavedScan[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [suggesting, setSuggesting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const pickLock = useRef(false);

  useEffect(() => setRecent(recentScans()), []);

  useEffect(() => {
    return () => {
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
    };
  }, []);

  // Debounced address typeahead (Maps-style dropdown).
  useEffect(() => {
    if (busy || pickLock.current) return;
    const q = address.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      setActive(-1);
      setSuggesting(false);
      return;
    }
    const t = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setSuggesting(true);
      try {
        const res = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(q)}`, {
          signal: ac.signal,
        });
        if (!res.ok) throw new Error("suggest failed");
        const data = (await res.json()) as { suggestions?: Suggestion[] };
        if (ac.signal.aborted) return;
        const list = data.suggestions ?? [];
        setSuggestions(list);
        setOpen(list.length > 0);
        setActive(list.length ? 0 : -1);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setSuggestions([]);
        setOpen(false);
      } finally {
        if (!ac.signal.aborted) setSuggesting(false);
      }
    }, 280);
    return () => {
      window.clearTimeout(t);
      abortRef.current?.abort();
    };
  }, [address, busy]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function pickFile(f: File | undefined) {
    if (!f || !isImageUpload(f)) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f); // keep original so exifr can still read HEIC GPS
    setError(null);
    try {
      const forPreview = isHeicFile(f) ? await toJpegFile(f) : f;
      setPreview(URL.createObjectURL(forPreview));
    } catch {
      setFile(null);
      setPreview(null);
      setError("Couldn't read that HEIC photo. Try exporting it as JPG, or take a new photo.");
    }
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function pickSuggestion(s: Suggestion) {
    pickLock.current = true;
    setAddress(s.label);
    setSuggestions([]);
    setOpen(false);
    setActive(-1);
    setError(null);
    window.setTimeout(() => {
      pickLock.current = false;
    }, 400);
  }

  const mode: Mode = file ? "photo" : "address";
  const ready = mode === "photo" ? !!file : address.trim().length > 5;

  function cancelScan() {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setBusy(false);
    setSteps(null);
    setNote(null);
    setError(null);
  }

  async function submit(e?: React.FormEvent, overrideAddress?: string) {
    e?.preventDefault();
    const addr = (overrideAddress ?? address).trim();
    if (busy) return;
    if (!overrideAddress && !ready) {
      setError(mode === "photo" ? "Add a photo of the house first." : "Type the full street address, with city and state.");
      return;
    }
    setOpen(false);
    setBusy(true);
    setError(null);
    setNote(null);
    setSteps(Object.fromEntries(STEPS.map((k) => [k, { status: "pending" }])) as Record<StepKey, StepState>);

    scanAbortRef.current?.abort();
    const ac = new AbortController();
    scanAbortRef.current = ac;

    const form = new FormData();
    const query: ScanQuery = {};
    let thumb: string | undefined;
    try {
      if (mode === "photo" && file && !overrideAddress) {
        try {
          form.append("photo", await shrink(file, 1280, 0.82), "house.jpg");
          thumb = await toDataUrl(await shrink(file, 360, 0.7));
        } catch {
          throw new Error("This photo format can't be read here. Try a JPG, PNG, or HEIC, or take the photo with your camera.");
        }
        if (ac.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (addr) {
          form.append("address", addr);
          query.address = addr;
        } else {
          let loc = await photoLocation(file);
          if (!loc) {
            setNote("Your photo has no location tag, so we're using your current location. Stand near the house.");
            loc = await deviceLocation();
          }
          if (ac.signal.aborted) throw new DOMException("Aborted", "AbortError");
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

      const { result } = await streamScan(
        form,
        (ev) => {
          if (ac.signal.aborted) return;
          if (ev.type === "step") {
            setSteps((s) => (s ? { ...s, [ev.key]: { status: ev.status, detail: ev.detail } } : s));
          }
        },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      saveScan({ result, query, photo: thumb });
      go(`/model/${encodeURIComponent(result.model.id)}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setBusy(false);
        setSteps(null);
        setNote(null);
        return;
      }
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
      setSteps(null);
    } finally {
      if (scanAbortRef.current === ac) scanAbortRef.current = null;
    }
  }

  function onAddrKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0 && suggestions[active]) {
      e.preventDefault();
      pickSuggestion(suggestions[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="w-full max-w-[440px] space-y-3 text-left">
      {steps ? (
        <div className="space-y-3 border border-bp-ink/60 bg-bp-deep/80 p-5">
          <ol className="space-y-3 font-data text-sm" aria-live="polite">
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
          <button
            type="button"
            onClick={cancelScan}
            className="w-full min-h-10 border border-bp-ink/70 font-data text-sm text-bp-ink transition hover:bg-bp-ink/15"
          >
            Cancel
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div ref={wrapRef} className="relative">
            <div className="flex bg-bp-ink text-bp">
              <label htmlFor="addr" className="sr-only">
                Street address of the house
              </label>
              <input
                ref={inputRef}
                id="addr"
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError(null);
                }}
                onFocus={() => {
                  if (suggestions.length) setOpen(true);
                }}
                onKeyDown={onAddrKeyDown}
                placeholder={file ? "Address (optional)" : "Enter an address"}
                autoComplete="off"
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

            {open && suggestions.length > 0 && (
              <ul
                id={listId}
                role="listbox"
                aria-label="Address suggestions"
                className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto border border-bp-ink/70 bg-bp-deep shadow-[0_12px_28px_rgba(0,0,0,0.35)]"
              >
                {suggestions.map((s, i) => (
                  <li key={s.label} role="option" aria-selected={i === active} id={`${listId}-opt-${i}`}>
                    <button
                      type="button"
                      className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left font-data transition ${
                        i === active ? "bg-bp-ink text-bp" : "text-bp-ink hover:bg-bp-ink/15"
                      }`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => {
                        // Prevent input blur before click applies.
                        e.preventDefault();
                        pickSuggestion(s);
                      }}
                    >
                      <span className="text-sm font-semibold">{s.primary}</span>
                      {s.secondary && (
                        <span className={`text-[11px] ${i === active ? "text-bp/75" : "text-bp-line"}`}>{s.secondary}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {suggesting && address.trim().length >= 3 && !open && (
              <p className="mt-1 font-data text-[10px] text-bp-line" aria-live="polite">
                Looking up addresses…
              </p>
            )}
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
                ref={fileRef}
                type="file"
                accept="image/*,.heic,.heif,image/heic,image/heif"
                capture="environment"
                className="sr-only"
                onChange={(e) => void pickFile(e.target.files?.[0])}
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
