"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Page change as a drawing-sheet swap that doubles as the loading screen: a blueprint sheet rolls
 * down over the page, the route changes underneath, and the sheet stays down until the new page says
 * it is ready (`useSheetHold`), then lifts away. Internal links are picked up automatically; code
 * that navigates calls `useSheetNav()`.
 */
type Phase = "idle" | "down" | "up";

const DOWN_MS = 600;
const UP_MS = 520;
const MIN_COVER_MS = 700; // long enough to read as a deliberate beat
const MAX_WAIT_MS = 12000; // never trap the user behind the sheet

type Ctx = { go: (href: string) => void; hold: () => () => void };
const NavContext = createContext<Ctx | null>(null);

export function useSheetNav(): (href: string) => void {
  const router = useRouter();
  const ctx = useContext(NavContext);
  return ctx?.go ?? ((href: string) => router.push(href));
}

/** Call from a page that loads data: the sheet stays down until the returned release is called. */
export function useSheetHold(): () => () => void {
  const ctx = useContext(NavContext);
  return ctx?.hold ?? (() => () => {});
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pathOnly(href: string) {
  return href.split(/[?#]/)[0] ?? href;
}

export default function SheetTransition({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const pathRef = useRef(pathname);
  const target = useRef<string | null>(null);
  const coveredAt = useRef(0);
  const holds = useRef(new Set<symbol>());
  const liftTimer = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  const goGen = useRef(0);

  const set = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const clearNavTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    if (liftTimer.current != null) {
      window.clearTimeout(liftTimer.current);
      liftTimer.current = null;
    }
  }, []);

  // Lift the sheet once: sheet is down, route has changed, nothing is still loading.
  const check = useCallback(() => {
    if (phaseRef.current !== "down" || !coveredAt.current || liftTimer.current != null) return;
    if (target.current && pathRef.current !== target.current) return;
    if (holds.current.size > 0) return;
    const wait = Math.max(0, MIN_COVER_MS - (Date.now() - coveredAt.current));
    liftTimer.current = window.setTimeout(() => {
      liftTimer.current = null;
      if (holds.current.size === 0) set("up");
    }, wait);
  }, [set]);

  const hold = useCallback(() => {
    const key = Symbol("hold");
    holds.current.add(key);
    return () => {
      if (holds.current.delete(key)) check();
    };
  }, [check]);

  const go = useCallback(
    (href: string) => {
      if (reducedMotion()) {
        router.push(href);
        return;
      }

      const path = pathOnly(href);

      // Already covering this destination — let the current cover/lift finish.
      if (phaseRef.current === "down" && target.current === path && coveredAt.current) {
        return;
      }

      clearNavTimers();
      holds.current.clear();
      target.current = path;
      const gen = ++goGen.current;

      const armMaxWait = (delayMs: number) => {
        timers.current.push(
          window.setTimeout(() => {
            if (goGen.current !== gen) return;
            if (phaseRef.current === "down") {
              holds.current.clear();
              set("up");
            }
          }, delayMs),
        );
      };

      const coverAndPush = () => {
        if (goGen.current !== gen) return;
        coveredAt.current = Date.now();
        router.push(href);
        check();
        armMaxWait(MAX_WAIT_MS);
      };

      // Sheet already fully down (e.g. mid-load hold) — retarget underneath without a bare push skip.
      if (phaseRef.current === "down" && coveredAt.current) {
        coverAndPush();
        return;
      }

      const beginDown = () => {
        if (goGen.current !== gen) return;
        coveredAt.current = 0;
        set("down");
        timers.current.push(
          window.setTimeout(() => {
            if (goGen.current !== gen) return;
            coverAndPush();
          }, DOWN_MS),
        );
        armMaxWait(DOWN_MS + MAX_WAIT_MS);
      };

      // Mid-lift: snap the sheet away first so the next roll-down is a full beat, not a half-gesture.
      if (phaseRef.current === "up") {
        set("idle");
        requestAnimationFrame(() => {
          requestAnimationFrame(beginDown);
        });
        return;
      }

      beginDown();
    },
    [router, set, check, clearNavTimers],
  );

  useEffect(() => {
    pathRef.current = pathname;
    check();
  }, [pathname, check]);

  useEffect(() => {
    if (phase !== "up") return;
    coveredAt.current = 0;
    const t = window.setTimeout(() => set("idle"), UP_MS);
    return () => window.clearTimeout(t);
  }, [phase, set]);

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

  const down = phase === "down";
  return (
    <NavContext.Provider value={{ go, hold }}>
      {children}
      <div
        aria-hidden
        className="bp-sheet-swap fixed inset-0 z-[100]"
        style={{
          transform: down ? "translateY(0)" : "translateY(-102%)",
          transition: `transform ${down ? DOWN_MS : phase === "up" ? UP_MS : 0}ms cubic-bezier(.55,0,.15,1)`,
          visibility: phase === "idle" ? "hidden" : "visible",
          pointerEvents: phase === "idle" ? "none" : "auto",
        }}
      >
        <div className="bp-ruler-x" />
        <div className="bp-ruler-y" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 font-data text-[11px] uppercase tracking-[0.2em] text-bp-ink">
          <svg width="220" height="6" aria-hidden>
            <line className="bp-route" x1="0" y1="3" x2="220" y2="3" stroke="#ff8a6b" strokeWidth="2.4" />
          </svg>
          Loading
        </div>
      </div>
    </NavContext.Provider>
  );
}
