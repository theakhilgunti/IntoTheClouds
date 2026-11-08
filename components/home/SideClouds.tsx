import type { CSSProperties } from "react";

type CloudShape = "cumulus" | "ridge" | "wispy" | "bank" | "puff" | "stratus";
type Layer = "near" | "mid" | "far";

/**
 * 10 lanes, staggered in phase. Vertical bands + alternating left anchors
 * keep paths from stacking on top of each other.
 */
const CLOUDS: {
  shape: CloudShape;
  layer: Layer;
  delaySec: number;
  style: CSSProperties;
}[] = [
  { shape: "cumulus", layer: "near", delaySec: 0, style: { top: "2%", left: "10%", width: "min(32vw, 320px)" } },
  { shape: "bank", layer: "far", delaySec: -5, style: { top: "11%", left: "56%", width: "min(24vw, 240px)" } },
  { shape: "stratus", layer: "mid", delaySec: -10, style: { top: "20%", left: "6%", width: "min(34vw, 340px)" } },
  { shape: "puff", layer: "near", delaySec: -15, style: { top: "30%", left: "50%", width: "min(28vw, 280px)" } },
  { shape: "ridge", layer: "mid", delaySec: -20, style: { top: "40%", left: "16%", width: "min(30vw, 300px)" } },
  { shape: "wispy", layer: "far", delaySec: -25, style: { top: "50%", left: "64%", width: "min(26vw, 260px)" } },
  { shape: "bank", layer: "mid", delaySec: -8, style: { top: "60%", left: "4%", width: "min(32vw, 320px)" } },
  { shape: "cumulus", layer: "near", delaySec: -18, style: { top: "70%", left: "46%", width: "min(30vw, 300px)" } },
  { shape: "stratus", layer: "far", delaySec: -30, style: { top: "80%", left: "22%", width: "min(28vw, 280px)" } },
  { shape: "puff", layer: "mid", delaySec: -12, style: { top: "88%", left: "58%", width: "min(30vw, 300px)" } },
];

export default function SideClouds() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden select-none"
    >
      {CLOUDS.map((c, i) => (
        <div key={i} className="absolute" style={c.style}>
          <Cloud shape={c.shape} layer={c.layer} delaySec={c.delaySec} className="block h-auto w-full" />
        </div>
      ))}

      <div className="absolute inset-y-[6%] left-[10%] right-[10%] rounded-[42%] bg-bp/50 blur-2xl max-md:left-[2%] max-md:right-[2%] max-md:bg-bp/60 md:left-[16%] md:right-[16%] lg:left-[20%] lg:right-[20%]" />
    </div>
  );
}

const PATHS: Record<CloudShape, { body: string; detail?: string; dash?: string }> = {
  cumulus: {
    body: "M42 102c-20 0-34-14-34-32 0-16 12-28 28-30 6-24 28-40 54-40 22 0 40 12 50 30 10-8 22-12 36-12 30 0 54 22 56 50 18 2 32 16 32 34 0 20-16 34-36 34H42z",
    detail: "M72 78c8-16 24-26 42-26m48 6c10-12 24-18 40-18",
    dash: "M50 112h210",
  },
  ridge: {
    body: "M28 108c-14 0-24-10-24-24s10-24 24-24c2-18 18-32 38-32 14 0 26 6 34 16 8-14 24-24 42-24 26 0 46 18 48 42 14 0 26 12 26 28 0 16-12 28-28 28H28z",
    detail: "M54 86c10-12 26-18 42-16m36-2c8-10 20-14 32-12",
    dash: "M34 116h200",
  },
  wispy: {
    body: "M36 96c-12-2-22-12-20-24 2-12 14-20 26-18 4-16 20-28 38-26 12 2 22 10 26 20 8-8 20-12 32-10 18 4 30 18 28 34 12 4 20 16 16 28-4 14-18 22-32 20H48c-8 0-14-4-12-14z",
    detail: "M60 70c14-8 32-6 44 4m28 2c12-8 28-6 38 4",
  },
  bank: {
    body: "M20 110c-10 0-18-8-18-18s8-18 18-18c0-20 16-36 36-36 12 0 22 4 30 12C96 36 116 28 138 32c20 4 34 20 36 40 16-2 30 10 30 26 0 16-12 28-28 28H20z",
    detail: "M48 88c12-10 28-14 44-10m40 0c10-8 24-10 36-6",
    dash: "M28 118h190",
  },
  puff: {
    body: "M60 100c-16 0-28-12-28-28 0-14 10-24 24-26 4-18 20-30 40-30 14 0 26 6 34 16 6-4 14-6 22-6 22 0 40 16 42 36 12 2 22 12 22 24 0 14-12 26-26 26H60z",
    detail: "M78 74c6-10 18-16 30-14m28 2c6-8 16-12 26-10",
  },
  stratus: {
    body: "M16 92c-8 0-14-6-14-14s6-14 14-14c2-14 14-24 30-24 10 0 18 4 24 10 6-12 20-20 36-20 18 0 32 12 36 28 10-6 22-8 34-6 20 4 34 20 34 40 0 12-8 22-20 24H30c-8 0-14-4-14-12z",
    detail: "M44 68h48m28 0h56",
    dash: "M24 106h240",
  },
};

function Cloud({
  shape,
  layer,
  delaySec,
  className,
}: {
  shape: CloudShape;
  layer: Layer;
  delaySec: number;
  className?: string;
}) {
  const p = PATHS[shape];
  return (
    <svg
      className={`bp-cloud bp-cloud-${layer} ${className ?? ""}`}
      style={{ animationDelay: `${delaySec}s` }}
      viewBox="0 0 320 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        d={p.body}
        fill="var(--color-bp-ink)"
        fillOpacity="0.1"
        stroke="var(--color-bp-line)"
        strokeWidth="2.25"
        strokeLinejoin="round"
      />
      {p.detail ? (
        <path
          d={p.detail}
          stroke="var(--color-bp-ink)"
          strokeOpacity="0.4"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ) : null}
      {p.dash ? (
        <path
          d={p.dash}
          stroke="var(--color-bp-ink)"
          strokeOpacity="0.25"
          strokeWidth="1"
          strokeDasharray="4 6"
        />
      ) : null}
    </svg>
  );
}
