"use client";

import type { SavedScan } from "@/lib/client/clientStore";
import type { AttributeReport, SourceReport } from "@/lib/scan/sources";

const FROM_STYLE: Record<AttributeReport["from"], { label: string; cls: string }> = {
  map: { label: "Map data", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  footprint: { label: "Map data", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  photos: { label: "From photos", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  estimated: { label: "Estimated", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
};

const STATUS_STYLE: Record<SourceReport["status"], string> = {
  used: "text-emerald-300",
  skipped: "text-neutral-500",
  failed: "text-red-300",
};

export default function ScanReport({
  scan,
  onClose,
  onRescan,
  rescanning,
}: {
  scan: SavedScan;
  onClose: () => void;
  onRescan?: () => void;
  rescanning: boolean;
}) {
  const { result } = scan;
  const s = result.summary;
  const known = result.attributes.filter((a) => a.from !== "estimated");
  const guessed = result.attributes.filter((a) => a.from === "estimated");

  const Row = ({ a }: { a: AttributeReport }) => (
    <li className="flex items-start justify-between gap-3 border-b border-white/5 py-2 last:border-0">
      <div>
        <div className="text-sm text-neutral-400">{a.field}</div>
        <div className="font-semibold text-white first-letter:uppercase">{a.value}</div>
        {a.note && <div className="text-xs text-neutral-500">{a.note}</div>}
      </div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${FROM_STYLE[a.from].cls}`}>
        {FROM_STYLE[a.from].label}
      </span>
    </li>
  );

  return (
    <aside
      className="absolute inset-x-0 bottom-0 z-20 max-h-[78dvh] overflow-y-auto rounded-t-2xl border border-white/10 bg-neutral-950/95 p-5 text-left text-white backdrop-blur sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[400px] sm:rounded-2xl"
      aria-label="How this model was built"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">How this was built</h2>
          <p className="text-sm text-neutral-400">
            Scanned {new Date(result.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
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
          <div key={k} className="rounded-xl bg-white/[0.04] p-2">
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">{k}</div>
            <div className="font-bold first-letter:uppercase">{v}</div>
          </div>
        ))}
      </div>

      {result.warnings.length > 0 && (
        <div className="mb-5 space-y-2">
          {result.warnings.map((w) => (
            <p key={w} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {w}
            </p>
          ))}
        </div>
      )}

      <section className="mb-5">
        <h3 className="mb-1 text-xs font-bold uppercase tracking-widest text-neutral-500">What we found</h3>
        <ul>{known.map((a) => <Row key={a.field} a={a} />)}</ul>
      </section>

      {guessed.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-widest text-neutral-500">What we estimated</h3>
          <ul>{guessed.map((a) => <Row key={a.field} a={a} />)}</ul>
        </section>
      )}

      {(scan.photo || result.images.length > 0) && (
        <section className="mb-5">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-widest text-neutral-500">Images we looked at</h3>
          <div className="grid grid-cols-2 gap-2">
            {scan.photo && (
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scan.photo} alt="Your photo" className="aspect-square w-full rounded-lg object-cover" />
                <figcaption className="mt-1 text-xs text-neutral-500">Your photo</figcaption>
              </figure>
            )}
            {result.images.map((img) => (
              <figure key={img.label}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.label} className="aspect-square w-full rounded-lg object-cover" />
                <figcaption className="mt-1 text-xs text-neutral-500">{img.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <section className="mb-5">
        <h3 className="mb-1 text-xs font-bold uppercase tracking-widest text-neutral-500">Data sources</h3>
        <ul>
          {result.sources.map((src) => (
            <li key={src.id} className="border-b border-white/5 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{src.name}</span>
                <span className={`text-xs font-bold uppercase ${STATUS_STYLE[src.status]}`}>{src.status}</span>
              </div>
              <p className="text-sm text-neutral-400">{src.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {onRescan && (
        <button
          onClick={onRescan}
          disabled={rescanning}
          className="min-h-11 w-full rounded-xl border border-white/15 font-bold text-white hover:border-yellow-400/60 disabled:opacity-60"
        >
          {rescanning ? "Re-scanning…" : "Re-scan this house"}
        </button>
      )}
    </aside>
  );
}
