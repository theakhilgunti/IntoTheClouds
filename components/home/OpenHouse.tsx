"use client";

import { useEffect, useRef } from "react";

/** Plan-space corners of the house footprint projected to isometric screen space (relative to its centre). */
const CORNERS: [number, number][] = [
  [-17.7, -55.1],
  [95.5, 10.2],
  [17.7, 55.1],
  [-95.5, -10.2],
];
const CX = 340;
const BASE = 215;

/**
 * Decorative blueprint house: two floors that lift apart and settle, a marching escape
 * route on the ground floor, and a little mouse parallax. Purely visual (aria-hidden).
 * Mutates SVG attributes directly in a rAF loop so React never re-renders.
 */
export default function OpenHouse() {
  const rig = useRef<SVGGElement>(null);
  const f1 = useRef<SVGGElement>(null);
  const f2 = useRef<SVGGElement>(null);
  const t1 = useRef<SVGTextElement>(null);
  const t2 = useRef<SVGTextElement>(null);
  const tn = useRef<SVGTextElement>(null);
  const posts = useRef<(SVGLineElement | null)[]>([]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    let raf = 0;

    const draw = (lift: number) => {
      f1.current?.setAttribute("transform", `translate(${CX},${BASE})`);
      f2.current?.setAttribute("transform", `translate(${CX},${BASE - lift})`);
      CORNERS.forEach(([x, y], i) => {
        const p = posts.current[i];
        if (!p) return;
        p.setAttribute("x1", String(CX + x));
        p.setAttribute("y1", String(BASE + y));
        p.setAttribute("x2", String(CX + x));
        p.setAttribute("y2", String(BASE - lift + y));
      });
      t1.current?.setAttribute("x", String(CX + 112));
      t1.current?.setAttribute("y", String(BASE + 14));
      t2.current?.setAttribute("x", String(CX + 112));
      t2.current?.setAttribute("y", String(BASE - lift + 14));
      if (tn.current) {
        tn.current.setAttribute("x", String(CX));
        tn.current.setAttribute("y", String(BASE + 82));
        tn.current.textContent = `${(8 + Math.round((lift / 70) * 32) / 10).toFixed(1)} m`;
      }
      rig.current?.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
    };

    const loop = (ms: number) => {
      const lift = 16 + 54 * (0.5 - 0.5 * Math.cos((ms / 1000) * 0.9));
      tx += (mx * 10 - tx) * 0.08;
      ty += (my * 6 - ty) * 0.08;
      draw(lift);
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      mx = e.clientX / window.innerWidth - 0.5;
      my = e.clientY / window.innerHeight - 0.5;
    };

    if (reduce) {
      draw(50);
    } else {
      window.addEventListener("pointermove", onMove);
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  const plan = "scale(1,.577) rotate(45)";
  return (
    <svg viewBox="0 75 680 235" aria-hidden className="h-auto w-full max-w-[680px]">
      <style>{`.oh *{vector-effect:non-scaling-stroke}`}</style>
      <g ref={rig} className="oh">
        <g stroke="#9ebcff" strokeWidth="1" strokeDasharray="3 4" fill="none">
          {CORNERS.map((_, i) => (
            <line key={i} ref={(el) => void (posts.current[i] = el)} />
          ))}
        </g>

        <g ref={f1}>
          <g transform={plan} fill="none" stroke="#eaf1ff" strokeLinecap="square">
            <rect x="-80" y="-55" width="160" height="110" fill="#0f3a8e" fillOpacity=".9" strokeWidth="3" />
            <path d="M-10 -55 V-10 M-80 5 H30 M30 5 V20" strokeWidth="1.6" />
            <path d="M40 -42 H70 V-12 H40 Z M40 -34 H70 M40 -26 H70 M40 -18 H70" strokeWidth="1" />
            <path className="bp-route" d="M-30 55 V30 H55 V-25" stroke="#ff8a6b" strokeWidth="2.4" />
            <circle cx="-30" cy="55" r="4" fill="#ff8a6b" stroke="none" />
            <circle className="bp-ping" cx="-30" cy="55" r="4" stroke="#ff8a6b" strokeWidth="1.2" />
          </g>
        </g>

        <g ref={f2}>
          <g transform={plan} fill="none" stroke="#eaf1ff" strokeLinecap="square">
            <rect x="-80" y="-55" width="160" height="110" fill="#0f3a8e" fillOpacity=".9" strokeWidth="3" />
            <path d="M-10 -55 V20 M-10 20 H40 M40 20 V55 M-80 0 H-10" strokeWidth="1.6" />
          </g>
        </g>

        <g fontSize="11" fill="#9ebcff" fontFamily="var(--font-data)">
          <text ref={t1}>1F</text>
          <text ref={t2}>2F</text>
          <text ref={tn} fill="#eaf1ff" textAnchor="middle">
            11.2 m
          </text>
        </g>
      </g>
    </svg>
  );
}
