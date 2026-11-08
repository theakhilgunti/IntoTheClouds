"use client";

import type { SavedScan } from "@/lib/clientStore";
import type { AttributeReport, SourceReport } from "@/lib/sources";
import type { BuildingModel, Point } from "@/packages/schema/building-model";
import FloorPlanPanel from "./FloorPlanPanel";

const FROM_STYLE: Record<AttributeReport["from"], { label: string; cls: string }> = {
  map: { label: "Map data", cls: "border-bp-ink text-bp-ink" },
  footprint: { label: "Map data", cls: "border-bp-ink text-bp-ink" },
  photos: { label: "From photos", cls: "border-bp-line text-bp-line" },
  estimated: { label: "Estimated", cls: "border-dashed border-bp-red text-bp-red" },
};

const STATUS_STYLE: Record<SourceReport["status"], string> = {
  used: "text-bp-ink",
  skipped: "text-bp-line/80",
  failed: "text-bp-red",
};

export default function ScanReport({
  scan,
  onClose,
  onRescan,
  rescanning,
  onApplied,
}: {
  scan: SavedScan;
  onClose: () => void;
  onRescan?: () => void;
  rescanning: boolean;
  onApplied?: (model: BuildingModel) => void;
}) {
  const { result } = scan;
  const s = result.summary;
  const known = result.attributes.filter((a) => a.from !== "estimated");
  const guessed = result.attributes.filter((a) => a.from === "estimated");

  const Row = ({ a }: { a: AttributeReport }) => (
    <li className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-2 last:border-0">
      <div>
        <div className="text-sm text-bp-line">{a.field}</div>
        <div className="font-data text-white first-letter:uppercase">{a.value}</div>
        {a.note && <div className="text-xs text-bp-line/80">{a.note}</div>}
      </div>
      <span className={`shrink-0 border px-2 py-0.5 font-data text-[11px] ${FROM_STYLE[a.from].cls}`}>
        {FROM_STYLE[a.from].label}
      </span>
    </li>
  );

  return (
    <aside
      className="absolute inset-x-0 bottom-0 z-20 max-h-[78dvh] overflow-y-auto border border-bp-ink/60 bg-bp-deep p-5 text-left text-bp-ink sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[400px]"
      aria-label="How this model was built"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl uppercase tracking-[0.03em] text-white">How this was built</h2>
          <p className="text-sm text-bp-line">
            Scanned {new Date(result.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center border border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2 text-center">
        {[
          ["Footprint", `${s.width.toFixed(1)}×${s.depth.toFixed(1)} m`],
          ["Floors", String(s.stories)],
          ["Faces", s.facing],
        ].map(([k, v]) => (
          <div key={k} className="border border-bp-ink/30 p-2">
            <div className="text-[11px] uppercase tracking-wider text-bp-line/80">{k}</div>
            <div className="font-bold first-letter:uppercase">{v}</div>
          </div>
        ))}
      </div>

      {result.warnings.length > 0 && (
        <div className="mb-5 space-y-2">
          {result.warnings.map((w) => (
            <p key={w} className="border border-dashed border-bp-red px-3 py-2 text-sm text-bp-red">
              {w}
            </p>
          ))}
        </div>
      )}

      <section className="mb-5">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">What we found</h3>
        <ul>{known.map((a) => <Row key={a.field} a={a} />)}</ul>
      </section>

      {guessed.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">What we estimated</h3>
          <ul>{guessed.map((a) => <Row key={a.field} a={a} />)}</ul>
        </section>
      )}

      {(scan.photo || result.images.length > 0) && (
        <section className="mb-5">
          <h3 className="mb-2 font-data text-xs uppercase tracking-widest text-bp-line/80">Images we looked at</h3>
          <div className="grid grid-cols-2 gap-2">
            {scan.photo && (
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scan.photo} alt="Your photo" className="aspect-square w-full object-cover" />
                <figcaption className="mt-1 text-xs text-bp-line/80">Your photo</figcaption>
              </figure>
            )}
            {result.images.map((img) => (
              <figure key={img.label}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.label} className="aspect-square w-full object-cover" />
                <figcaption className="mt-1 text-xs text-bp-line/80">{img.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <section className="mb-5">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Data sources</h3>
        <ul>
          {result.sources.map((src) => (
            <li key={src.id} className="border-b border-bp-ink/15 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{src.name}</span>
                <span className={`text-xs font-bold uppercase ${STATUS_STYLE[src.status]}`}>{src.status}</span>
              </div>
              <p className="text-sm text-bp-line">{src.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {onApplied && (
        <section className="mb-5">
          <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Import a verified floor plan</h3>
          <p className="mb-2 text-sm text-bp-line">
            Upload a CubiCasa SVG or plan photo to replace the estimated rooms on one floor. Shell still comes from the map.
          </p>
          <FloorPlanPanel
            model={result.model}
            streetDir={(result.summary.streetDir as Point | null | undefined) ?? null}
            onApplied={onApplied}
          />
        </section>
      )}

      {onRescan && (
        <button
          onClick={onRescan}
          disabled={rescanning}
          className="min-h-11 w-full border border-bp-ink/60 font-data text-sm uppercase text-bp-ink hover:bg-bp-ink/15 disabled:opacity-60"
        >
          {rescanning ? "Re-scanning…" : "Re-scan this house"}
        </button>
      )}
    </aside>
  );
}
