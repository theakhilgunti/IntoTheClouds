"use client";

import { useMemo } from "react";
import type { BuildingModel, Marker } from "@/packages/schema/building-model";
import { computeSizeUp, type SizeUp } from "@/lib/sizeup";

function floorLabel(n: number): string {
  if (n < 0) return "Basement";
  if (n === 0) return "Ground";
  return `Floor ${n}`;
}

function meters(n: number): string {
  return `${n.toFixed(0)} m`;
}

export default function SizeUpCard({
  model,
  markers,
  sizeUp: precomputed,
  onClose,
}: {
  model: BuildingModel;
  markers?: Marker[];
  sizeUp?: SizeUp;
  onClose?: () => void;
}) {
  const sizeUp = useMemo(
    () => precomputed ?? computeSizeUp(model, markers ?? model.markers),
    [precomputed, model, markers],
  );

  const confLabel =
    sizeUp.interiorStatus === "verified"
      ? "Verified"
      : sizeUp.interiorStatus === "estimated"
        ? "Estimated"
        : "Unknown";
  const confCls =
    sizeUp.interiorStatus === "verified"
      ? "border-bp-ink text-bp-ink"
      : sizeUp.interiorStatus === "estimated"
        ? "border-dashed border-bp-red text-bp-red"
        : "border-bp-line text-bp-line";

  return (
    <aside
      className="absolute inset-x-0 bottom-0 z-20 max-h-[78dvh] overflow-y-auto border border-bp-ink/60 bg-bp-deep p-5 text-left text-bp-ink sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[400px]"
      aria-label="Firefighter size-up"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl uppercase tracking-[0.03em] text-white">Size-Up</h2>
          <p className="text-sm text-bp-line">Initial command brief</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center border border-bp-ink/45 text-bp-ink hover:bg-bp-ink/15"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>

      <p className="mb-5 border border-bp-ink/40 bg-bp-ink/10 px-3 py-3 font-data text-sm leading-snug text-white">
        {sizeUp.summaryLine}
      </p>

      <div className="mb-5 grid grid-cols-3 gap-2 text-center">
        {[
          ["Stories", String(sizeUp.stories)],
          ["Basement", sizeUp.basement ? "Yes" : "No"],
          ["Interior", confLabel],
        ].map(([k, v]) => (
          <div key={k} className="border border-bp-ink/30 p-2">
            <div className="text-[11px] uppercase tracking-wider text-bp-line/80">{k}</div>
            <div className={`font-bold ${k === "Interior" ? "" : "text-white"}`}>
              {k === "Interior" ? (
                <span className={`inline-block border px-1.5 py-0.5 font-data text-[11px] ${confCls}`}>{v}</span>
              ) : (
                v
              )}
            </div>
          </div>
        ))}
      </div>

      {sizeUp.egress.cutOff && (
        <p className="mb-5 border border-dashed border-bp-red px-3 py-3 text-sm font-semibold uppercase tracking-wide text-bp-red">
          Stair cut-off — only vertical link blocked by fire
        </p>
      )}

      <section className="mb-5">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Egress</h3>
        <ul>
          <li className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-3 last:border-0">
            <div>
              <div className="text-sm text-bp-line">Primary (front)</div>
              <div className="font-data text-white">
                {sizeUp.egress.primary
                  ? `${meters(sizeUp.egress.primary.length)}${sizeUp.egress.primary.estimated ? " · est." : ""} · ${sizeUp.egress.primary.doorId}`
                  : "No route"}
              </div>
            </div>
          </li>
          <li className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-3 last:border-0">
            <div>
              <div className="text-sm text-bp-line">Secondary (bailout)</div>
              <div className="font-data text-white">
                {sizeUp.egress.secondary
                  ? `${meters(sizeUp.egress.secondary.length)}${sizeUp.egress.secondary.estimated ? " · est." : ""} · ${sizeUp.egress.secondary.doorId}`
                  : "No alternate exit"}
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section className="mb-5">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Hydrants</h3>
        {sizeUp.hydrants.length === 0 ? (
          <p className="py-2 text-sm text-bp-line">None mapped nearby</p>
        ) : (
          <ul>
            {sizeUp.hydrants.map((h, i) => (
              <li
                key={`${h.label}-${i}`}
                className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-3 last:border-0"
              >
                <div>
                  <div className="font-data text-white">{h.label}</div>
                  <div className="text-xs text-bp-line/80">
                    {h.pos[0].toFixed(1)}, {h.pos[1].toFixed(1)}
                  </div>
                </div>
                <span className="shrink-0 border border-bp-ink px-2 py-1 font-data text-[11px] text-bp-ink">
                  {meters(h.distM)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-5">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Shutoffs</h3>
        {sizeUp.shutoffs.length === 0 ? (
          <p className="py-2 text-sm text-bp-line">None pinned</p>
        ) : (
          <ul>
            {sizeUp.shutoffs.map((s, i) => (
              <li
                key={`${s.kind}-${s.floor}-${i}`}
                className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-3 last:border-0"
              >
                <div>
                  <div className="font-data uppercase text-white">{s.kind}</div>
                  <div className="text-sm text-bp-line">{s.note}</div>
                </div>
                <span className="shrink-0 border border-bp-line px-2 py-1 font-data text-[11px] text-bp-line">
                  {floorLabel(s.floor)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-1">
        <h3 className="mb-1 font-data text-xs uppercase tracking-widest text-bp-line/80">Exposures</h3>
        {sizeUp.exposures.length === 0 ? (
          <p className="py-2 text-sm text-bp-line">No neighbor shells mapped</p>
        ) : (
          <ul>
            {sizeUp.exposures.map((e, i) => (
              <li
                key={`${e.label}-${i}`}
                className="flex items-start justify-between gap-3 border-b border-bp-ink/15 py-3 last:border-0"
              >
                <div className="font-data text-white">{e.label}</div>
                <span className="shrink-0 border border-bp-ink/45 px-2 py-1 font-data text-[11px] text-bp-ink">
                  {meters(e.distM)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
