"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Page change as a drawing-sheet swap: a blueprint sheet rolls down over the page
 * (rulers ticking along its edges), the route changes underneath, then the sheet lifts away.
 * Internal links are picked up automatically; code that navigates calls `useSheetNav()`.
 */
type Phase = "idle" | "down" | "up";

const DOWN_MS = 600;
const UP_MS = 520;
const MIN_COVER_MS = 140;

const NavContext = createContext<((href: string) => void) | null>(null);

export function useSheetNav(): (href: string) => void {
  const router = useRouter();
  const go = useContext(NavContext);
  return go ?? ((href: string) => router.push(href));
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function SheetTransition({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const target = useRef<string | null>(null);
  const coveredAt = useRef(0);
  const timers = useRef<number[]>([]);

  const set = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const go = useCallback(
    (href: string) => {
      if (reducedMotion() || phaseRef.current !== "idle") {
        router.push(href);
        return;
      }
      target.current = href.split(/[?#]/)[0];
      set("down");
      later(() => {
        coveredAt.current = Date.now();
        router.push(href);
      }, DOWN_MS);
      // Never leave the sheet down if the route doesn't change.
      later(() => {
        if (phaseRef.current === "down") set("up");
      }, DOWN_MS + 4000);
    },
    [router, set, later],
  );

  // Route changed while the sheet is down: lift it.
  useEffect(() => {
    if (phaseRef.current !== "down" || !coveredAt.current) return;
    if (target.current && pathname !== target.current) return;
    const wait = Math.max(0, MIN_COVER_MS - (Date.now() - coveredAt.current));
    later(() => set("up"), wait);
  }, [pathname, set, later]);

  useEffect(() => {
    if (phase !== "up") return;
    coveredAt.current = 0;
    const t = window.setTimeout(() => set("idle"), UP_MS);
    return () => window.clearTimeout(t);
  }, [phase, set]);

  // Intercept clicks on internal links.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      e.preventDefault();
      go(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [go]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  const y = phase === "down" ? "translateY(0)" : phase === "up" ? "translateY(-102%)" : "translateY(-102%)";
  const dur = phase === "down" ? DOWN_MS : phase === "up" ? UP_MS : 0;

  return (
    <NavContext.Provider value={go}>
      {children}
      <div
        aria-hidden
        className="bp-sheet-swap fixed inset-0 z-[100]"
        style={{
          transform: y,
          transition: `transform ${dur}ms cubic-bezier(.55,0,.15,1)`,
          visibility: phase === "idle" ? "hidden" : "visible",
          pointerEvents: phase === "idle" ? "none" : "auto",
        }}
      >
        <div className="bp-ruler-x" />
        <div className="bp-ruler-y" />
      </div>
    </NavContext.Provider>
  );
}
