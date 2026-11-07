"use client";

import { useEffect, useState } from "react";
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
    <div className="flex h-full items-center justify-center bg-neutral-950 text-yellow-400">Loading 3D model…</div>
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

  useEffect(() => {
    let cancel = false;
    const refreshIfEmpty = (scan: SavedScan) => {
      const model = scan.result.model;
      const empty = model.interior?.status === "unknown" && model.floors.every((f) => f.rooms.length === 0);
      const stale = (model.source === "address" || model.source === "photo") && model.compound?.basis !== "outline-v1";
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
      <Viewer key={`${model.id}-${version}`} model={model} />

      <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-start justify-between gap-3">
        <div className="pointer-events-auto max-w-sm rounded-lg bg-black/55 px-3 py-2 text-white backdrop-blur">
          <div className="flex items-baseline justify-between gap-4">
            <Link href="/" className="text-xs font-semibold tracking-tight text-neutral-300">
              Cloud<span className="text-yellow-400">Scan</span>
            </Link>
            <span className="flex gap-3 text-xs text-neutral-400">
              {state.kind === "scan" && !panel && (
                <button onClick={() => setPanel(true)} className="hover:text-white">
                  Details
                </button>
              )}
              <button onClick={downloadModel} className="hover:text-white">
                Save
              </button>
              <Link href="/" className="hover:text-white">
                New
              </Link>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium">{shortAddress(model.address) || `${model.lat.toFixed(5)}, ${model.lng.toFixed(5)}`}</div>
          <div className="text-[11px] text-neutral-400">
            {rescanning ? "Updating this house…" : interiorLine}
            {match === "nearest" ? " · closest building, confirm it's yours" : ""}
          </div>
          {nearby.length > 1 && (
            <div className="mt-1">
              <button onClick={() => setWrongOpen((v) => !v)} className="text-[11px] text-neutral-300 underline-offset-2 hover:underline">
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
                        className={`rounded-full px-2 py-0.5 text-[11px] ${selected ? "bg-white text-black" : "bg-white/10 text-neutral-200 hover:bg-white/20"}`}
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
