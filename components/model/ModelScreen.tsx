"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { demoModel } from "@/lib/demo";
import { loadScan, saveScan, type SavedScan } from "@/lib/clientStore";
import { streamScan } from "@/lib/scanClient";
import type { BuildingModel } from "@/packages/schema/building-model";
import type { ScanResult } from "@/lib/sources";
import ScanReport from "./ScanReport";

// WebGL only runs in the browser.
const Viewer = dynamic(() => import("@/components/viewer/Viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-yellow-400">Loading 3D model…</div>
  ),
});

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "demo"; model: BuildingModel }
  | { kind: "scan"; scan: SavedScan };

export default function ModelScreen({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [panel, setPanel] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (id === "demo") return setState({ kind: "demo", model: demoModel });
    const local = loadScan(id);
    if (local) return setState({ kind: "scan", scan: local });
    fetch(`/api/models/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((result: ScanResult | null) => {
        if (!result) return setState({ kind: "missing" });
        const scan: SavedScan = { result, query: { address: result.model.address } };
        saveScan(scan);
        setState({ kind: "scan", scan });
      })
      .catch(() => setState({ kind: "missing" }));
  }, [id]);

  async function rescan() {
    if (state.kind !== "scan") return;
    const q = state.scan.query;
    const form = new FormData();
    if (q.address) form.append("address", q.address);
    else if (q.lat != null && q.lng != null) {
      form.append("lat", String(q.lat));
      form.append("lng", String(q.lng));
    } else return;
    form.append("rescan", "1");
    setRescanning(true);
    try {
      const { result } = await streamScan(form, () => {});
      const scan = { ...state.scan, result };
      saveScan(scan);
      setState({ kind: "scan", scan });
      setVersion((v) => v + 1);
    } catch {
      /* keep the existing model */
    } finally {
      setRescanning(false);
    }
  }

  if (state.kind === "loading") {
    return <div className="flex h-full items-center justify-center bg-neutral-950 text-yellow-400">Loading 3D model…</div>;
  }
  if (state.kind === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
        <h1 className="text-2xl font-black">We don&apos;t have this house saved</h1>
        <p className="max-w-sm text-neutral-400">Scans are kept on the device that made them for now. Scan it again to rebuild the model.</p>
        <Link href="/" className="rounded-xl bg-yellow-400 px-6 py-3 font-black uppercase text-black">
          Scan a house
        </Link>
      </div>
    );
  }

  const model = state.kind === "demo" ? state.model : state.scan.result.model;
  const conf = Math.round(model.confidence * 100);
  const interior = model.interior;
  const legacy = state.kind === "scan" && !interior; // saved before interiors were tracked: layout was guessed

  return (
    <div className="relative h-full w-full">
      <Viewer key={`${model.id}-${version}`} model={model} />

      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col-reverse gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="pointer-events-auto min-w-0 flex-1 rounded-xl bg-black/80 px-4 py-3 text-white backdrop-blur sm:max-w-md sm:flex-none">
          <Link href="/" className="text-xs font-black tracking-tight">
            Cloud<span className="text-yellow-400">Scan</span>
          </Link>
          <div className="mt-1 truncate font-semibold">{model.address || `${model.lat.toFixed(5)}, ${model.lng.toFixed(5)}`}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-700">
              <span className="block h-full bg-yellow-400" style={{ width: `${conf}%` }} />
            </span>
            {conf}% outline confidence · {interior?.status === "verified" ? "interior verified" : interior ? "interior unknown" : state.kind === "demo" ? "demo data" : "old scan"}
          </div>
        </div>
        <div className="pointer-events-auto flex justify-end gap-2">
          {state.kind === "scan" && !panel && (
            <button
              onClick={() => setPanel(true)}
              className="min-h-11 whitespace-nowrap rounded-xl bg-yellow-400 px-4 text-sm font-black text-black hover:bg-yellow-300"
            >
              <span className="sm:hidden">Details</span>
              <span className="hidden sm:inline">How this was built</span>
            </button>
          )}
          <Link
            href="/"
            className="flex min-h-11 items-center whitespace-nowrap rounded-xl bg-black/80 px-4 text-sm font-bold text-white hover:bg-black"
          >
            New scan
          </Link>
        </div>
      </div>

      {interior?.status === "unknown" && (
        <div className="pointer-events-auto absolute left-3 right-3 top-32 z-10 max-w-md rounded-xl border-2 border-red-500 bg-black/90 px-4 py-3 text-white backdrop-blur sm:top-28">
          <div className="text-sm font-black uppercase tracking-wide text-red-400">Interior unknown · this house needs a scan</div>
          <p className="mt-1 text-xs text-neutral-300">Only the outside is shown. We don&apos;t guess rooms. Why:</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-neutral-200">
            {interior.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {interior?.status === "verified" && (
        <div className="pointer-events-none absolute left-3 top-32 z-10 rounded-xl border border-emerald-500 bg-black/85 px-3 py-2 text-xs font-bold text-emerald-300 sm:top-28">
          Interior verified · {interior.source}
        </div>
      )}
      {legacy && (
        <div className="pointer-events-auto absolute left-3 right-3 top-32 z-10 max-w-md rounded-xl border-2 border-amber-400 bg-black/90 px-4 py-3 text-white sm:top-28">
          <div className="text-sm font-black uppercase tracking-wide text-amber-300">Old scan · room layout was guessed</div>
          <p className="mt-1 text-xs text-neutral-300">Open &quot;How this was built&quot; and press Re-scan to see what is actually known.</p>
        </div>
      )}

      {state.kind === "scan" && panel && (
        <ScanReport scan={state.scan} onClose={() => setPanel(false)} onRescan={rescan} rescanning={rescanning} />
      )}
    </div>
  );
}
