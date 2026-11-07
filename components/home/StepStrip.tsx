"use client";

import { useEffect, useState } from "react";

const STEPS = ["Address", "Scan", "Plan"];

/** Tiny Address → Scan → Plan strip that lights each step in turn. */
export default function StepStrip() {
  const [on, setOn] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setOn((n) => (n + 1) % STEPS.length), 1300);
    return () => clearInterval(id);
  }, []);

  return (
    <ol className="flex items-center gap-2 font-data text-[11px]" aria-label="How it works">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={`border px-2.5 py-1 transition-colors duration-300 ${
              i === on ? "border-bp-ink bg-bp-ink text-bp" : "border-bp-ink/50 text-bp-line"
            }`}
          >
            {s}
          </span>
          {i < STEPS.length - 1 && <span aria-hidden className="text-bp-line">→</span>}
        </li>
      ))}
    </ol>
  );
}
