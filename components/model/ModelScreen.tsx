"use client";

import { useEffect, useRef, useState } from "react";
import { useSheetHold } from "@/components/ui/SheetTransition";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { demoModel } from "@/lib/demo";
import { loadScan, saveScan, type SavedScan } from "@/lib/clientStore";
import { streamScan } from "@/lib/scanClient";
import type { BuildingModel } from "@/packages/schema/building-model";
import type { ScanResult } from "@/lib/sources";
import ScanReport from "./ScanReport";
import { mergeKnownFloors } from "@/lib/interior";

// WebGL only runs in the browser.
const Viewer = dynamic(() => import("@/components/viewer/Viewer"), {
  ssr: false,
  loading: () => (
    <div className="bp-sheet flex h-full items-center justify-center font-data text-bp-ink">Loading 3D model…</div>
  ),
});

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "demo"; model: BuildingModel }
  | { kind: "scan"; scan: SavedScan };

function shortAddress(address: string): string {
  const comma = address.match(/^(\d+[a-z]?)\s*,\s*([^,]+)/i);
  if (comma) return `${comma[1]} ${comma[2].trim()}`;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join(", ") || address;
}

export default function ModelScreen({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [panel, setPanel] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [version, setVersion] = useState(0);
  const [wrongOpen, setWrongOpen] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const holdSheet = useSheetHold();
  const releaseSheet = useRef<(() => void) | null>(null);

  // Keep the page-change sheet down until the model has drawn its first frame.
  useEffect(() => {
    releaseSheet.current = holdSheet();
    return () => releaseSheet.current?.();
  }, [holdSheet]);
  useEffect(() => {
    if (viewerReady || state.kind === "missing") releaseSheet.current?.();
  }, [viewerReady, state.kind]);

  useEffect(() => {
    let cancel = false;
    const refreshIfEmpty = (scan: SavedScan) => {
      const model = scan.result.model;
      const empty = model.interior?.status === "unknown" && model.floors.every((f) => f.rooms.length === 0);
      const stale =
        (model.source === "address" || model.source === "photo") &&
        (model.compound?.basis !== "compound-v22" || model.roof?.basis !== "roof-v3");
      if ((!empty && !stale) || !scan.query.address) return;
      const form = new FormData();
      form.append("address", scan.query.address);
      form.append("rescan", "1");
      streamScan(form, () => {})
        .then(({ result: fresh }) => {
          if (cancel) return;
          const next = { ...scan, result: { ...fresh, model: mergeKnownFloors(fresh.model, scan.result.model) } };
          saveScan(next);
          setState({ kind: "scan", scan: next });
          setVersion((v) => v + 1);
        })
        .catch(() => {});
    };

    if (id === "demo") {
      setState({ kind: "demo", model: demoModel });
      return;
    }
    const local = loadScan(id);
    if (local) {
      setState({ kind: "scan", scan: local });
      refreshIfEmpty(local);
      return () => {
        cancel = true;
      };
    }
    fetch(`/api/models/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((result: ScanResult | null) => {
        if (cancel) return;
        if (!result) return setState({ kind: "missing" });
        const scan: SavedScan = { result, query: { address: result.model.address } };
        saveScan(scan);
        setState({ kind: "scan", scan });
        refreshIfEmpty(scan);
      })
      .catch(() => {
        if (!cancel) setState({ kind: "missing" });
      });
    return () => {
      cancel = true;
    };
  }, [id]);

  async function rescan(wayId?: number) {
    if (state.kind !== "scan") return;
    const q = state.scan.query;
    const form = new FormData();
    if (q.address) form.append("address", q.address);
    else if (q.lat != null && q.lng != null) {
      form.append("lat", String(q.lat));
      form.append("lng", String(q.lng));
    } else return;
    form.append("rescan", "1");
    if (wayId != null) form.append("wayId", String(wayId));
    setRescanning(true);
    try {
      const { result: fresh } = await streamScan(form, () => {});
      const result = { ...fresh, model: mergeKnownFloors(fresh.model, state.scan.result.model) };
      const scan = { ...state.scan, result };
      saveScan(scan);
      if (result.model.id !== id) {
        router.push(`/model/${encodeURIComponent(result.model.id)}`);
        return;
      }
      setState({ kind: "scan", scan });
      setVersion((v) => v + 1);
      setWrongOpen(false);
    } catch {
      /* keep the existing model */
    } finally {
      setRescanning(false);
    }
  }

  function applyPlan(next: BuildingModel) {
    if (state.kind !== "scan") return;
    const interior = next.interior;
    const attributes = state.scan.result.attributes.map((a) =>
      a.field === "Interior"
        ? interior?.status === "verified"
          ? { ...a, value: "Verified", from: "map" as const, note: `Source: ${interior.source}` }
          : { ...a, value: "Partly known — needs a scan", note: interior?.reasons[0] ?? a.note }
        : a,
    );
    const result = { ...state.scan.result, model: next, attributes };
    const scan = { ...state.scan, result };
    saveScan(scan);
    setState({ kind: "scan", scan });
    setVersion((v) => v + 1);
  }

  function downloadModel() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(model, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${model.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (state.kind === "loading") {
    return <div className="bp-sheet flex h-full items-center justify-center font-data text-bp-ink">Loading 3D model…</div>;
  }
  if (state.kind === "missing") {
    return (
      <div className="bp-sheet flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-bp-ink">
        <h1 className="font-display text-4xl uppercase tracking-[0.02em] text-white">We don&apos;t have this house saved</h1>
        <p className="max-w-sm font-data text-sm text-bp-line">Scans are kept on the device that made them for now. Scan it again to rebuild the model.</p>
        <Link href="/" className="border border-bp-ink bg-bp-ink px-6 py-3 font-data text-sm uppercase text-bp hover:bg-transparent hover:text-bp-ink">
          Scan a house
        </Link>
      </div>
    );
  }

  const model = state.kind === "demo" ? state.model : state.scan.result.model;
  const interior = model.interior;
  const nearby = state.kind === "scan" ? state.scan.result.summary.nearby ?? [] : [];
  const match = state.kind === "scan" ? state.scan.result.summary.match : undefined;
  const interiorLine =
    interior?.status === "verified"
      ? "Rooms from your floor plan"
      : interior?.status === "estimated"
        ? model.compound?.features.some((f) => f.kind === "driveway" || f.kind === "road")
          ? "Street and driveway from the map · rooms follow the footprint"
          : model.compound?.features.some((f) => f.kind === "yard")
            ? "City lot around the house · rooms follow the footprint"
            : "Outline from the map · rooms follow the footprint"
        : state.kind === "demo"
          ? "Sample house"
          : "Outline from the map";

  return (
    <div className="relative h-full w-full">
      <Viewer key={`${model.id}-${version}`} model={model} onReady={() => setViewerReady(true)} />

      <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-start justify-between gap-3">
        <div className="pointer-events-auto max-w-sm border border-bp-ink/60 bg-bp-deep px-3.5 py-2.5 text-bp-ink">
          <div className="flex items-baseline justify-between gap-4">
            <Link href="/" className="font-display text-base uppercase tracking-[0.14em] text-bp-ink">
              Cloud<span className="text-bp-red">Scan</span>
            </Link>
            <span className="flex gap-3 font-data text-xs text-bp-line">
              {state.kind === "scan" && !panel && (
                <button onClick={() => setPanel(true)} className="hover:text-bp-ink">
                  Details
                </button>
              )}
              <button onClick={downloadModel} className="hover:text-bp-ink">
                Save
              </button>
              <Link href="/" className="hover:text-bp-ink">
                New
              </Link>
            </span>
          </div>
          <div className="mt-1 truncate font-display text-xl uppercase tracking-[0.03em] text-white">{shortAddress(model.address) || `${model.lat.toFixed(5)}, ${model.lng.toFixed(5)}`}</div>
          <div className="font-data text-[11px] text-bp-line">
            {rescanning ? "Updating this house…" : interiorLine}
            {match === "nearest" ? " · closest building, confirm it's yours" : ""}
          </div>
          {nearby.length > 1 && (
            <div className="mt-1">
              <button onClick={() => setWrongOpen((v) => !v)} className="font-data text-[11px] text-bp-line underline-offset-2 hover:text-bp-ink hover:underline">
                {wrongOpen ? "Hide nearby houses" : "Wrong house?"}
              </button>
              {wrongOpen && (
                <div className="mt-1 flex max-w-xs flex-wrap gap-1">
                  {nearby.map((house) => {
                    const selected = model.id === `osm-${house.id}`;
                    return (
                      <button
                        key={house.id}
                        disabled={rescanning || selected}
                        onClick={() => rescan(house.id)}
                        className={`border px-2 py-0.5 font-data text-[11px] ${selected ? "border-bp-ink bg-bp-ink text-bp" : "border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"}`}
                      >
                        {shortAddress(house.label)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <span
          className={`pointer-events-none border bg-bp-deep px-2.5 py-1 font-data text-[11px] uppercase ${
            interior?.status === "verified" || state.kind === "demo" ? "border-bp-ink text-bp-ink" : "border-dashed border-bp-red text-bp-red"
          }`}
        >
          {state.kind === "demo" ? "Sample" : interior?.status === "verified" ? "Verified" : interior?.status === "estimated" ? "Estimated inside" : "Exterior only"}
        </span>
      </div>

      {state.kind === "scan" && panel && (
        <ScanReport
          scan={state.scan}
          onClose={() => setPanel(false)}
          onRescan={() => rescan()}
          rescanning={rescanning}
          onApplied={applyPlan}
        />
      )}
    </div>
  );
}
