"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setupStatus, type ProAnchor } from "@/lib/pro";

/** Link between the website's Pro setup and the local FastAPI scanner backend (Phase 2). */

const URL_KEY = "cloudscan-pro-backend-url";
export const DEFAULT_BACKEND = "http://localhost:8000";

export type LinkState = "idle" | "linking" | "linked" | "error";

export interface SitePos {
  x: number;
  y: number;
  at: number;
}

export interface Signal {
  rssi: number;
  at: number;
}

const MAX_TRAIL = 400;
const MIN_STEP_M = 0.25;
/** A point with no reading for this long is shown as lost. */
export const LOST_AFTER_MS = 3000;

const signature = (a: ProAnchor[]) =>
  JSON.stringify(a.map((p) => [p.id, p.type, p.ip.trim(), Math.round(p.x * 100), Math.round(p.y * 100)]));

function loadUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_BACKEND;
  } catch {
    return DEFAULT_BACKEND;
  }
}

async function call(base: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join("; ") || `Backend error ${res.status}`
          : `Backend error ${res.status}`,
    );
  }
  return data as {
    linked: boolean;
    simulating: boolean;
    site: { x: number; y: number } | null;
  };
}

export function useProLink(enabled: boolean, houseId: string, anchors: ProAnchor[]) {
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_BACKEND);
  const [state, setState] = useState<LinkState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [site, setSite] = useState<SitePos | null>(null);
  const [linkedSig, setLinkedSig] = useState<string | null>(null);
  const [trail, setTrail] = useState<{ x: number; y: number }[]>([]);
  const [signals, setSignals] = useState<Record<string, Signal>>({});
  const [now, setNow] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => setBackendUrlState(loadUrl()), []);

  const setBackendUrl = (u: string) => {
    setBackendUrlState(u);
    try {
      localStorage.setItem(URL_KEY, u);
    } catch {}
  };

  const base = backendUrl.trim().replace(/\/+$/, "");
  const ready = setupStatus(anchors).ready;
  const sig = signature(anchors);
  const stale = state === "linked" && linkedSig !== null && linkedSig !== sig;

  const pushSite = useCallback((p: { x: number; y: number }) => {
    setSite({ x: p.x, y: p.y, at: Date.now() });
    setTrail((t) => {
      const last = t[t.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP_M) return t;
      const next = [...t, { x: p.x, y: p.y }];
      return next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next;
    });
  }, []);

  const applyStatus = useCallback((s: { linked: boolean; simulating: boolean; site: { x: number; y: number } | null }) => {
    setSimulating(s.simulating);
    if (s.site) pushSite(s.site);
  }, [pushSite]);

  /** Send the three typed points + IPs to the backend. */
  const link = async () => {
    if (!ready) return;
    setState("linking");
    setError(null);
    try {
      const s = await call(base, "/api/pro/setup", {
        method: "POST",
        body: JSON.stringify({
          house_id: houseId,
          anchors: anchors.map((a) => ({ id: a.id, type: a.type, ip: a.ip.trim(), x: a.x, y: a.y })),
        }),
      });
      setLinkedSig(sig);
      setSite(null);
      setTrail([]);
      setSignals({});
      applyStatus(s);
      setState("linked");
    } catch (e) {
      setState("error");
      setError(e instanceof TypeError ? `Can't reach the scanner backend at ${base}. Is it running?` : (e as Error).message);
    }
  };

  const simulate = async (on: boolean) => {
    setError(null);
    try {
      applyStatus(await call(base, "/api/pro/simulate", { method: "POST", body: JSON.stringify({ on }) }));
    } catch (e) {
      setError(e instanceof TypeError ? `Can't reach the scanner backend at ${base}.` : (e as Error).message);
    }
  };

  // Live position over WebSocket while linked.
  useEffect(() => {
    if (!enabled || state !== "linked") return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws/dashboard");
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "telemetry_update") {
            if (m.site) pushSite(m.site);
            const at = Date.now();
            const scans = Array.isArray(m.raw_scans) ? (m.raw_scans as { bssid?: string; rssi_dbm?: number }[]) : [];
            if (scans.length) {
              setSignals((prev) => {
                const next = { ...prev };
                for (const sc of scans) if (sc.bssid && typeof sc.rssi_dbm === "number") next[sc.bssid] = { rssi: sc.rssi_dbm, at };
                return next;
              });
            }
          } else if (m.type === "pro_setup") {
            setTrail([]);
            setSignals({});
          } else if (m.type === "init_state" && m.pro) applyStatus(m.pro);
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(open, 1500);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [enabled, state, base, applyStatus, pushSite]);

  // Clock so "lost" / "last seen" labels age without new messages.
  useEffect(() => {
    if (!enabled || state !== "linked") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled, state]);

  // After a page reload, pick up a backend that is already linked.
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    call(base, "/api/pro/status")
      .then((s) => {
        if (off || !s.linked) return;
        applyStatus(s);
        setState("linked");
        setLinkedSig((prev) => prev ?? sig);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, base]);

  return { backendUrl, setBackendUrl, state, error, simulating, site, trail, signals, now, ready, stale, link, simulate };
}
