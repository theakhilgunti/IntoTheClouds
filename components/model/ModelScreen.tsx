"use client";

import { useEffect, useRef, useState } from "react";
import { useSheetHold, useSheetNav } from "@/components/ui/SheetTransition";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { demoModel } from "@/lib/demo";
import { loadScan, saveScan, type SavedScan } from "@/lib/clientStore";
import { streamScan } from "@/lib/scanClient";
import type { BuildingModel } from "@/packages/schema/building-model";
import { STEP_LABELS, type ScanResult, type StepKey } from "@/lib/sources";
import { findNeighborFeature, reframeScanToNeighbor } from "@/lib/reframe-neighbor";
import ScanReport from "./ScanReport";
import { mergeKnownFloors } from "@/lib/interior";

const SCAN_STEPS = Object.keys(STEP_LABELS) as StepKey[];

function progressFromStep(key: StepKey, status: "active" | "done" | "skipped"): number {
  const i = SCAN_STEPS.indexOf(key);
  if (i < 0) return 0;
  if (status === "active") return Math.round(((i + 0.35) / SCAN_STEPS.length) * 100);
  return Math.round(((i + 1) / SCAN_STEPS.length) * 100);
}

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

/** Prefer real street addresses over generic "Neighbor" / "Building N" placeholders. */
function isKnownNeighborAddress(label: string | null | undefined): boolean {
  const s = label?.trim() ?? "";
  if (!s) return false;
  if (/^neighbor$/i.test(s)) return false;
  if (/^building\s+\d+$/i.test(s)) return false;
  return true;
}

/** Wrong-house choices: summary.nearby merged with addressed neighbor shells in the compound. */
function neighborHouseChoices(
  summaryNearby: { id: number; label: string }[],
  model: { id: string; compound?: { features: { id: string; kind: string; label?: string | null }[] } | null },
): { id: number; label: string }[] {
  const byId = new Map<number, string>();
  for (const n of summaryNearby) {
    if (n.id == null || !n.label) continue;
    byId.set(n.id, n.label);
  }
  for (const f of model.compound?.features ?? []) {
    if (f.kind !== "neighbor") continue;
    const m = /^neighbor-(\d+)$/.exec(f.id);
    if (!m) continue;
    const label = f.label?.trim();
    if (!isKnownNeighborAddress(label)) continue;
    byId.set(Number(m[1]), label!);
  }
  const main = /^osm-(\d+)$/.exec(model.id);
  const rows = [...byId.entries()].map(([id, label]) => ({ id, label }));
  // Prefer known addresses; keep current house even if label is weak so "Wrong house?" still opens.
  const known = rows.filter((h) => isKnownNeighborAddress(h.label));
  if (known.length >= 1) {
    if (main) {
      const mainId = Number(main[1]);
      if (!known.some((h) => h.id === mainId)) {
        const fallback = rows.find((h) => h.id === mainId);
        if (fallback) known.unshift(fallback);
      }
    }
    return known;
  }
  return rows;
}

export default function ModelScreen({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [panel, setPanel] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [nearbyLoading, setNearbyLoading] = useState<string | null>(null);
  const [nearbyMode, setNearbyMode] = useState<"switch" | "load" | null>(null);
  const [nearbyProgress, setNearbyProgress] = useState(0);
  const [nearbyStep, setNearbyStep] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [wrongOpen, setWrongOpen] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const holdSheet = useSheetHold();
  const sheetGo = useSheetNav();
  const releaseSheet = useRef<(() => void) | null>(null);
  const rescanAbort = useRef<AbortController | null>(null);
  /** Bumps to cancel an in-flight instant neighbor reframe transition. */
  const switchGen = useRef(0);
  const switchHold = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the switch overlay after navigating to the neighbor's model URL.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("cloudscan:nearbySwitch");
      if (!raw) return;
      sessionStorage.removeItem("cloudscan:nearbySwitch");
      const parsed = JSON.parse(raw) as { label?: string };
      setNearbyMode("switch");
      setNearbyLoading(parsed.label || "nearby house");
      setNearbyProgress(100);
      setNearbyStep("Opening model…");
      setRescanning(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Drop the carried-over switch overlay once the new viewer has painted.
  useEffect(() => {
    if (!viewerReady || nearbyMode !== "switch" || nearbyProgress < 100) return;
    if (switchHold.current) return;
    switchHold.current = setTimeout(() => {
      switchHold.current = null;
      setRescanning(false);
      setNearbyMode(null);
      setNearbyLoading(null);
      setNearbyProgress(0);
      setNearbyStep(null);
    }, 280);
    return () => {
      if (switchHold.current) {
        clearTimeout(switchHold.current);
        switchHold.current = null;
      }
    };
  }, [viewerReady, nearbyMode, nearbyProgress]);

  // Keep the page-change sheet down until the model has drawn its first frame.
  useEffect(() => {
    releaseSheet.current = holdSheet();
    return () => releaseSheet.current?.();
  }, [holdSheet]);
  useEffect(() => {
    if (viewerReady || state.kind === "missing") releaseSheet.current?.();
  }, [viewerReady, state.kind]);

  // Leaving the model page (home, etc.) must cancel any in-flight nearby rescan.
  useEffect(() => {
    return () => {
      rescanAbort.current?.abort();
      rescanAbort.current = null;
      if (switchHold.current) clearTimeout(switchHold.current);
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    const refreshIfEmpty = (scan: SavedScan) => {
      const model = scan.result.model;
      const empty = model.interior?.status === "unknown" && model.floors.every((f) => f.rooms.length === 0);
      const stale =
        (model.source === "address" || model.source === "photo") &&
        (model.compound?.basis !== "compound-v68" || model.roof?.basis !== "roof-v4");
      // Neighbor reframes are already valid site data — don't background-rescan the old address.
      if (model.interior?.source?.includes("neighbor reframe")) return;
      if ((!empty && !stale) || !scan.query.address) return;
      const form = new FormData();
      form.append("address", scan.query.address);
      form.append("rescan", "1");
      const osmWay = /^osm-(\d+)$/.exec(model.id);
      if (osmWay) form.append("wayId", osmWay[1]!);
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

  /** Wrong-house switch: visible overlay, then reframe; hold overlay so it isn't a one-frame flash. */
  function switchToNeighbor(wayId: number, nearbyLabel?: string) {
    if (state.kind !== "scan") return;
    const prev = state.scan;
    if (prev.result.model.id === `osm-${wayId}`) return;
    if (!findNeighborFeature(prev.result.model, wayId)) {
      // Shell missing from compound — fall back to a full rescan for this way.
      void rescan(wayId, nearbyLabel);
      return;
    }
    const label = nearbyLabel || "nearby house";
    const gen = ++switchGen.current;
    const started = performance.now();
    rescanAbort.current?.abort();
    rescanAbort.current = null;
    if (switchHold.current) {
      clearTimeout(switchHold.current);
      switchHold.current = null;
    }
    setWrongOpen(false);
    setRescanning(true);
    setNearbyMode("switch");
    setNearbyLoading(label);
    setNearbyProgress(20);
    setNearbyStep("Switching focus…");

    // Double rAF: first paint shows the overlay, second runs the reframe.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (switchGen.current !== gen) return;
        setNearbyProgress(65);
        setNearbyStep("Reframing site…");
        try {
          const result = reframeScanToNeighbor(prev.result, wayId);
          const scan = {
            ...prev,
            result,
            query: {
              ...prev.query,
              address: result.model.address || prev.query.address,
              lat: result.model.lat,
              lng: result.model.lng,
            },
          };
          saveScan(scan);
          setNearbyProgress(100);
          setNearbyStep("Opening model…");
          const finish = () => {
            if (switchGen.current !== gen) return;
            if (result.model.id !== id) {
              try {
                sessionStorage.setItem("cloudscan:nearbySwitch", JSON.stringify({ label }));
              } catch {
                /* ignore */
              }
              router.push(`/model/${encodeURIComponent(result.model.id)}`);
              return;
            }
            setViewerReady(false);
            setState({ kind: "scan", scan });
            setVersion((v) => v + 1);
            // Keep overlay until the remounted viewer reports ready (see effect above).
          };
          const holdMs = Math.max(0, 450 - (performance.now() - started));
          switchHold.current = setTimeout(finish, holdMs);
        } catch {
          if (switchGen.current !== gen) return;
          void rescan(wayId, nearbyLabel);
        }
      });
    });
  }

  async function rescan(wayId?: number, nearbyLabel?: string) {
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
    rescanAbort.current?.abort();
    const ac = new AbortController();
    rescanAbort.current = ac;
    setRescanning(true);
    setNearbyMode(wayId != null ? "load" : null);
    setNearbyLoading(wayId != null ? nearbyLabel || "nearby house" : null);
    setNearbyProgress(wayId != null ? 4 : 0);
    setNearbyStep(wayId != null ? STEP_LABELS.locate : null);
    try {
      const { result: fresh } = await streamScan(
        form,
        (ev) => {
          if (ac.signal.aborted || ev.type !== "step") return;
          setNearbyProgress((p) => Math.max(p, progressFromStep(ev.key, ev.status)));
          setNearbyStep(ev.detail?.trim() || STEP_LABELS[ev.key]);
        },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      setNearbyProgress(100);
      setNearbyStep("Opening model…");
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
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      /* keep the existing model */
    } finally {
      if (rescanAbort.current === ac) rescanAbort.current = null;
      // Skip state updates after unmount / home navigation abort.
      if (!ac.signal.aborted) {
        setRescanning(false);
        setNearbyMode(null);
        setNearbyLoading(null);
        setNearbyProgress(0);
        setNearbyStep(null);
      }
    }
  }

  /** Stop an in-flight nearby-house load / reframe and stay on the current model. */
  function cancelNearbyLoad() {
    switchGen.current += 1;
    if (switchHold.current) {
      clearTimeout(switchHold.current);
      switchHold.current = null;
    }
    try {
      sessionStorage.removeItem("cloudscan:nearbySwitch");
    } catch {
      /* ignore */
    }
    rescanAbort.current?.abort();
    rescanAbort.current = null;
    setRescanning(false);
    setNearbyMode(null);
    setNearbyLoading(null);
    setNearbyProgress(0);
    setNearbyStep(null);
  }

  /** Abort nearby load and leave the model page. */
  function goHomeFromNearby() {
    cancelNearbyLoad();
    sheetGo("/");
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
  const nearby =
    state.kind === "scan"
      ? neighborHouseChoices(state.scan.result.summary.nearby ?? [], state.scan.result.model)
      : [];
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
      <Viewer
        key={`${model.id}-${version}`}
        model={model}
        onReady={() => setViewerReady(true)}
        onDownload={downloadModel}
        card={
          <div className="border border-bp-ink/60 bg-bp-deep text-bp-ink" style={{ padding: "0.65em 0.85em", maxWidth: "24em" }}>
            <div className="flex items-baseline justify-between" style={{ gap: "1.2em" }}>
              <Link href="/" className="font-display uppercase tracking-[0.14em] text-bp-ink" style={{ fontSize: "1.33em" }}>
                Cloud<span className="text-bp-red">Scan</span>
              </Link>
              <span className="flex font-data text-bp-line" style={{ gap: "1em" }}>
                {state.kind === "scan" && !panel && (
                  <button onClick={() => setPanel(true)} className="hover:text-bp-ink">
                    Details
                  </button>
                )}
              </span>
            </div>
            <div className="truncate font-display uppercase tracking-[0.03em] text-white" style={{ fontSize: "1.67em", marginTop: "0.1em" }}>
              {shortAddress(model.address) || `${model.lat.toFixed(5)}, ${model.lng.toFixed(5)}`}
            </div>
            <div className="font-data text-bp-line [@media(max-height:620px)]:hidden" style={{ fontSize: "0.92em" }}>
              {nearbyLoading
                ? `Loading ${nearbyLoading}…`
                : rescanning
                  ? "Updating this house…"
                  : interiorLine}
              {!rescanning && match === "nearest" ? " · closest building, confirm it's yours" : ""}
            </div>
            {nearby.length > 1 && (
              <div style={{ marginTop: "0.3em" }}>
                <button
                  onClick={() => setWrongOpen((v) => !v)}
                  disabled={!!nearbyLoading}
                  className="font-data text-bp-line underline-offset-2 hover:text-bp-ink hover:underline disabled:opacity-50"
                  style={{ fontSize: "0.92em" }}
                >
                  {wrongOpen ? "Hide nearby houses" : "Wrong house?"}
                </button>
                {wrongOpen && (
                  <div className="flex flex-wrap" style={{ marginTop: "0.3em", gap: "0.3em", maxWidth: "22em" }}>
                    {nearby.map((house) => {
                      const selected = model.id === `osm-${house.id}`;
                      const loadingThis = nearbyLoading === shortAddress(house.label);
                      return (
                        <button
                          key={house.id}
                          disabled={rescanning || selected}
                          onClick={() => switchToNeighbor(house.id, shortAddress(house.label))}
                          className={`border font-data ${
                            selected
                              ? "border-bp-ink bg-bp-ink text-bp"
                              : loadingThis
                                ? "border-bp-red bg-bp-red/20 text-bp-ink"
                                : "border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"
                          }`}
                          style={{ padding: "0.15em 0.6em", fontSize: "0.92em" }}
                          aria-busy={loadingThis}
                        >
                          {loadingThis ? `Loading ${shortAddress(house.label)}…` : shortAddress(house.label)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        }
        badge={
          <span
            className={`block whitespace-nowrap border bg-bp-deep px-2.5 py-1 font-data text-[11px] uppercase ${
              interior?.status === "verified" || state.kind === "demo" ? "border-bp-ink text-bp-ink" : "border-dashed border-bp-red text-bp-red"
            }`}
          >
            {state.kind === "demo" ? "Sample" : interior?.status === "verified" ? "Verified" : interior?.status === "estimated" ? "Estimated inside" : "Exterior only"}
          </span>
        }
      />

      {nearbyLoading && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bp-deep/65"
          role="status"
          aria-live="polite"
        >
          <div className="pointer-events-auto border border-bp-ink/70 bg-bp-deep px-6 py-5 text-center shadow-lg">
            <div className="font-display text-2xl uppercase tracking-[0.04em] text-white">
              {nearbyMode === "switch" ? "Switching house" : "Loading house"}
            </div>
            <div className="mt-2 font-data text-sm text-bp-ink">{nearbyLoading}</div>
            {nearbyStep && (
              <div className="mt-2 font-data text-[11px] uppercase tracking-[0.1em] text-bp-line">{nearbyStep}</div>
            )}
            <div
              className="mx-auto mt-4 h-1.5 w-52 overflow-hidden bg-bp-ink/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={nearbyProgress}
              aria-label="House switch progress"
            >
              <div
                className="h-full bg-bp-red transition-[width] duration-300 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, nearbyProgress))}%` }}
              />
            </div>
            <div className="mt-1.5 font-data text-[11px] tabular-nums text-bp-line">{nearbyProgress}%</div>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={cancelNearbyLoad}
                className="min-h-10 border border-bp-ink/70 px-5 font-data text-sm text-bp-ink transition hover:bg-bp-ink/15"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={goHomeFromNearby}
                className="min-h-10 bg-bp-ink px-5 font-data text-sm text-bp transition hover:bg-bp-red"
              >
                Go home
              </button>
            </div>
          </div>
        </div>
      )}

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
