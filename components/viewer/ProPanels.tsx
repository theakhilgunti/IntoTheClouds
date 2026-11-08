"use client";

import { useEffect, useState, type ReactNode } from "react";
import { LOST_AFTER_MS, type useProLink } from "@/lib/proLink";
import {
  ANCHOR_COLOR,
  ANCHOR_UNSET_COLOR,
  checkProLogin,
  dist,
  isValidIp,
  setupStatus,
  type AnchorType,
  type ProAnchor,
} from "@/lib/pro";

/*
 * Pro panel — monochrome blueprint ink. Colour is reserved for the three
 * anchor roles (Origin / X / Y) and for genuine problems (red).
 * All sizes are rem or %, so it scales with the viewer's font size and
 * becomes a full-width bottom sheet on narrow screens.
 */

const label =
  "font-data text-[0.6875rem] uppercase tracking-[0.14em] text-[#6f8a77] before:mr-1.5 before:text-[#3ddc84]/60 before:content-['//']";
const field =
  "min-w-0 w-full rounded-md border border-[#22322a] bg-black/50 px-2.5 py-2 font-data text-[0.8125rem] text-[#e8f3ea] caret-[#3ddc84] outline-none transition-colors placeholder:text-[#3f5546] focus:border-[#3ddc84]/80 focus:shadow-[0_0_0_3px_rgba(61,220,132,0.12)]";
const btnBase =
  "rounded-md px-3.5 py-2 font-data text-[0.75rem] uppercase tracking-[0.1em] transition-colors whitespace-nowrap";
const btnPrimary = `${btnBase} bg-[#3ddc84] font-semibold text-[#04120a] hover:bg-[#6cf0a6]`;
const btnGhost = `${btnBase} border border-[#2c4034] text-[#c9d8cd] hover:border-[#3ddc84]/70 hover:text-[#3ddc84]`;
const linkBtn = "font-data text-[0.75rem] text-[#6f8a77] underline-offset-4 transition-colors hover:text-[#3ddc84] hover:underline";

const TYPE_NAME: Record<AnchorType, string> = { origin: "Origin", x: "X axis", y: "Y axis" };
const roleColor = (a: ProAnchor) => (a.type ? ANCHOR_COLOR[a.type] : ANCHOR_UNSET_COLOR);

function Dot({ color, size = "0.625rem" }: { color: string; size?: string }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

export function ProLogin({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState(false);
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]">
      <form
        className="w-full max-w-[21rem] animate-[proPop_300ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none rounded-lg border border-[#22322a] bg-[#070a08] p-6 text-[#c9d8cd] shadow-[0_0_0_1px_rgba(61,220,132,0.06),0_24px_64px_rgba(0,0,0,0.65)]"
        onSubmit={(e) => {
          e.preventDefault();
          if (checkProLogin(user, pass)) onSuccess();
          else setErr(true);
        }}
      >
        <div className="font-data text-[1.125rem] font-semibold tracking-[0.08em] text-[#e8f3ea]"><span className="text-[#3ddc84]">&gt;</span> PRO_LOGIN</div>
        <p className="mt-1 font-data text-[0.75rem] text-[#6f8a77]">Sign in to place the tracking points.</p>
        <label className={`${label} mt-5 block`}>
          User
          <input className={`${field} mt-1.5`} value={user} autoFocus autoComplete="off" onChange={(e) => { setUser(e.target.value); setErr(false); }} />
        </label>
        <label className={`${label} mt-3.5 block`}>
          Password
          <input className={`${field} mt-1.5`} type="password" value={pass} autoComplete="off" onChange={(e) => { setPass(e.target.value); setErr(false); }} />
        </label>
        {err && <p className="mt-2.5 font-data text-[0.75rem] text-[#ff6b6b]" role="alert">Wrong user or password.</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
          <button type="submit" className={btnPrimary}>Sign in</button>
        </div>
      </form>
    </div>
  );
}

type Step = 0 | 1 | 2;

export function ProAnchorPanel({
  open,
  anchors,
  selectedId,
  onSelect,
  onChange,
  link,
  drill,
  floors,
  trackLevel,
  onTrackLevel,
  onReset,
  onSignOut,
  onClose,
}: {
  /** Panel stays mounted so it can slide both in and out. */
  open: boolean;
  anchors: ProAnchor[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<ProAnchor>) => void;
  link: ReturnType<typeof useProLink>;
  drill: {
    phase: "idle" | "walking" | "spraying" | "out";
    fires: number;
    hasFireMarker: boolean;
    onAddFire: () => void;
    onStart: () => void;
    onStop: () => void;
  };
  floors: { level: number; name?: string }[];
  trackLevel: number;
  onTrackLevel: (level: number) => void;
  onReset: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  // Mount closed, then flip on the next frame so the very first open also slides in.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const shown = open && armed;
  const status = setupStatus(anchors);
  const linked = link.state === "linked";
  const fresh = !!link.site && link.now - link.site.at < LOST_AFTER_MS;
  const [step, setStep] = useState<Step>(() => (linked ? 2 : 0));
  const drilling = drill.phase === "walking" || drill.phase === "spraying";

  const pill = linked ? (fresh ? "Live" : "Connected") : "Not connected";
  const floorName = (f: { level: number; name?: string }) =>
    f.name || (f.level < 0 ? "Basement" : f.level === 0 ? "Ground" : `Floor ${f.level + 1}`);

  return (
    <section
      aria-label="Pro tracking"
      aria-hidden={!shown}
      className={`absolute inset-x-3 bottom-3 z-30 transition-[translate,opacity,visibility] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        shown
          ? "pointer-events-auto visible translate-x-0 translate-y-0 opacity-100"
          : "pointer-events-none invisible translate-y-8 opacity-0 sm:translate-x-[calc(100%+1.5rem)] sm:translate-y-0"
      } flex max-h-[min(40rem,calc(100%-7.5rem))] flex-col overflow-hidden rounded-lg border border-[#22322a] bg-[#070a08] text-[#c9d8cd] shadow-[0_0_0_1px_rgba(61,220,132,0.06),0_24px_64px_rgba(0,0,0,0.65)] sm:left-auto sm:right-3 sm:w-[22rem]`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 opacity-[0.04] [background:repeating-linear-gradient(0deg,#fff_0,#fff_1px,transparent_1px,transparent_3px)]"
      />
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-3.5">
        <span className="font-data text-[0.9375rem] font-semibold tracking-[0.08em] text-[#e8f3ea]">
          <span className="text-[#3ddc84]">&gt;</span> PRO
          <span className="ml-0.5 inline-block animate-pulse text-[#3ddc84]" aria-hidden>_</span>
        </span>
        <span className="flex items-center gap-3">
          <span
            className={`flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-data text-[0.6875rem] uppercase tracking-[0.1em] ${
              fresh ? "border-[#3ddc84]/50 text-[#3ddc84]" : "border-[#22322a] text-[#6f8a77]"
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                fresh ? "animate-pulse bg-[#3ddc84] shadow-[0_0_8px_#3ddc84]" : linked ? "bg-[#6f8a77]" : "border border-[#6f8a77]"
              }`}
            />
            {pill}
          </span>
          <button className="text-[#6f8a77] transition-colors hover:text-[#e8f3ea]" onClick={onClose} aria-label="Close panel">✕</button>
        </span>
      </header>

      <nav className="flex shrink-0 border-y border-[#17221b]" role="tablist">
        {(["Place", "Connect", "Track"] as const).map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={step === i}
            onClick={() => setStep(i as Step)}
            className={`relative flex-1 px-2 py-2.5 font-data text-[0.75rem] uppercase tracking-[0.12em] transition-colors ${
              step === i ? "text-[#3ddc84]" : "text-[#6f8a77] hover:text-[#c9d8cd]"
            }`}
          >
            <span className={step === i ? "text-[#3ddc84]" : "opacity-60"}>[{i + 1}]</span> {t}
            {step === i && <span className="absolute inset-x-3 bottom-0 h-px bg-[#3ddc84] shadow-[0_0_6px_#3ddc84]" />}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {step === 0 && (
          <>
            <p className="font-data text-[0.75rem] leading-relaxed text-[#6f8a77]">
              Drag the three dots on the map to where your devices sit, then label each one.
            </p>
            <ul className="space-y-2">
              {anchors.map((a) => {
                const ipBad = a.ip.trim() !== "" && !isValidIp(a.ip);
                const ipOk = a.ip.trim() !== "" && !ipBad;
                return (
                  <li
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    className={`rounded-lg border p-2.5 transition-colors ${a.id === selectedId ? "border-[#3ddc84]/60 bg-[#3ddc84]/[0.05]" : "border-[#17221b] hover:border-[#3ddc84]/35"}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Dot color={roleColor(a)} size="0.75rem" />
                      <span className="w-6 shrink-0 font-data text-[0.75rem] text-[#6f8a77]">{a.id.toUpperCase()}</span>
                      <select
                        aria-label={`Type for point ${a.id.toUpperCase()}`}
                        className={`${field} !py-1.5`}
                        value={a.type ?? ""}
                        onFocus={() => onSelect(a.id)}
                        onChange={(e) => onChange(a.id, { type: (e.target.value || null) as AnchorType | null })}
                      >
                        <option value="">Choose type</option>
                        {(["origin", "x", "y"] as AnchorType[]).map((t) => (
                          <option key={t} value={t}>{TYPE_NAME[t]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        aria-label={`Device IP for point ${a.id.toUpperCase()}`}
                        className={`${field} ${ipBad ? "!border-[#ff6b6b]" : ""}`}
                        placeholder="Device IP, e.g. 192.168.1.21"
                        inputMode="decimal"
                        value={a.ip}
                        onFocus={() => onSelect(a.id)}
                        onChange={(e) => onChange(a.id, { ip: e.target.value })}
                      />
                      <span className={`w-4 shrink-0 text-center text-[0.8125rem] ${ipBad ? "text-[#ff6b6b]" : "text-[#3ddc84]"}`} aria-hidden>
                        {ipOk ? "✓" : ipBad ? "!" : ""}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="font-data text-[0.6875rem] text-[#6f8a77]">
              Spacing {dist(anchors[0], anchors[1]).toFixed(1)} · {dist(anchors[1], anchors[2]).toFixed(1)} · {dist(anchors[2], anchors[0]).toFixed(1)} m
            </p>
            {!status.ready && (
              <p className="font-data text-[0.75rem] text-[#ff6b6b]" role="status">
                {status.problems[0]}
                {status.problems.length > 1 && ` · ${status.problems.length - 1} more`}
              </p>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p className="font-data text-[0.75rem] leading-relaxed text-[#6f8a77]">
              Send this layout to the scanner so it knows where each device is.
            </p>
            <ul className="divide-y divide-[#17221b] rounded-lg border border-[#17221b]">
              {anchors.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 px-3 py-2.5">
                  <Dot color={roleColor(a)} />
                  <span className="flex-1 font-data text-[0.8125rem] text-[#e8f3ea]">{a.type ? TYPE_NAME[a.type] : "No type"}</span>
                  <span className="min-w-0 truncate font-data text-[0.75rem] text-[#6f8a77]">{a.ip.trim() || "no IP"}</span>
                </li>
              ))}
            </ul>

            <details className="group">
              <summary className="cursor-pointer list-none font-data text-[0.75rem] text-[#6f8a77] hover:text-[#c9d8cd]">
                <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">›</span>Advanced · scanner address
              </summary>
              <input
                className={`${field} mt-2`}
                value={link.backendUrl}
                onChange={(e) => link.setBackendUrl(e.target.value)}
                aria-label="Scanner backend address"
                spellCheck={false}
              />
            </details>

            {!status.ready && (
              <p className="font-data text-[0.75rem] text-[#ff6b6b]" role="status">
                {status.problems[0]}{" "}
                <button className="underline underline-offset-4" onClick={() => setStep(0)}>Fix in Place</button>
              </p>
            )}
            {link.stale && <p className="font-data text-[0.75rem] text-[#ff6b6b]">Points changed since connecting. Connect again.</p>}
            {link.error && <p className="font-data text-[0.75rem] text-[#ff6b6b]" role="alert">{link.error}</p>}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                className={btnPrimary}
                onClick={async () => {
                  if (!status.ready) return;
                  await link.link();
                  setStep(2);
                }}
              >
                {link.state === "linking" ? "Connecting…" : linked && !link.stale ? "Reconnect" : "Connect"}
              </button>
              <button
                className={linkBtn}
                onClick={async () => {
                  if (!status.ready) return;
                  if (!linked || link.stale) await link.link();
                  await link.simulate(true);
                  setStep(2);
                }}
              >
                No devices yet? Run a demo walk
              </button>
            </div>
          </>
        )}

        {step === 2 && !linked && (
          <div className="py-6 text-center">
            <p className="font-data text-[0.9375rem] uppercase tracking-[0.1em] text-[#e8f3ea]">Not connected</p>
            <p className="mx-auto mt-1.5 max-w-[16rem] font-data text-[0.75rem] leading-relaxed text-[#6f8a77]">
              Connect the scanner to see the firefighter on the map.
            </p>
            <button className={`${btnPrimary} mt-4`} onClick={() => setStep(1)}>Go to Connect</button>
          </div>
        )}

        {step === 2 && linked && (
          <>
            <div>
              <div className={label}>Firefighter · approximate</div>
              {link.site ? (
                <div className="mt-1 font-data text-[1.625rem] font-semibold leading-tight tracking-[-0.01em] text-[#3ddc84]">
                  {link.site.x.toFixed(1)}, {link.site.y.toFixed(1)} <span className="text-[1rem] text-[#6f8a77]">m</span>
                </div>
              ) : (
                <div className="mt-1 font-data text-[0.8125rem] text-[#6f8a77]">Waiting for a signal…</div>
              )}
              {link.site && !fresh && <div className="mt-0.5 font-data text-[0.75rem] text-[#ff6b6b]">Signal lost · last known position</div>}
            </div>

            <div>
              <div className={label}>Signal</div>
              <ul className="mt-2 space-y-2">
                {anchors.map((a) => {
                  const sig = link.signals[a.ip.trim()];
                  const age = sig ? link.now - sig.at : null;
                  const live = age !== null && age < LOST_AFTER_MS;
                  const pct = sig && live ? Math.max(6, Math.min(100, ((sig.rssi + 90) / 50) * 100)) : 0;
                  return (
                    <li key={a.id} className="flex items-center gap-2.5 font-data text-[0.75rem]">
                      <Dot color={roleColor(a)} />
                      <span className="w-14 shrink-0 text-[#e8f3ea]">{a.type ? TYPE_NAME[a.type] : a.id.toUpperCase()}</span>
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-[#3ddc84]/10">
                        <span className="block h-full rounded-full bg-[#3ddc84] transition-[width] duration-300" style={{ width: `${pct}%` }} />
                      </span>
                      <span className={`w-[4.25rem] shrink-0 whitespace-nowrap text-right ${live ? "text-[#6f8a77]" : "text-[#ff6b6b]"}`}>
                        {sig ? (live ? `${Math.round(sig.rssi)} dBm` : "lost") : "none"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            {floors.length > 1 && (
              <div>
                <div className={label}>Show on floor</div>
                <div className="mt-2 flex overflow-hidden rounded-md border border-[#22322a]" role="group">
                  {floors.map((f) => (
                    <button
                      key={f.level}
                      onClick={() => onTrackLevel(f.level)}
                      className={`min-w-0 flex-1 truncate px-2 py-1.5 font-data text-[0.75rem] transition-colors ${
                        f.level === trackLevel ? "bg-[#3ddc84] text-[#04120a]" : "text-[#c9d8cd] hover:bg-[#3ddc84]/[0.08]"
                      }`}
                    >
                      {floorName(f)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <details className="group rounded-lg border border-[#17221b] px-3 py-2.5" open={drill.phase !== "idle"}>
              <summary className="cursor-pointer list-none font-data text-[0.75rem] uppercase tracking-[0.1em] text-[#6f8a77] hover:text-[#c9d8cd]">
                <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">›</span>Practice drill
              </summary>
              <p className="mt-2 font-data text-[0.75rem] leading-relaxed text-[#6f8a77]">
                A practice firefighter walks the dotted route through doors and up stairs, then puts the fire out.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button className={btnGhost} onClick={drill.onAddFire} disabled={drilling}>Add fire</button>
                {drilling ? (
                  <button className={btnGhost} onClick={drill.onStop}>Stop</button>
                ) : (
                  <button className={btnPrimary} onClick={drill.onStart}>Send firefighter</button>
                )}
                {drill.phase === "out" && <button className={linkBtn} onClick={drill.onStop}>Clear</button>}
              </div>
              {!drilling && drill.fires === 0 && (
                <p className="mt-2 font-data text-[0.6875rem] text-[#6f8a77]">
                  {drill.hasFireMarker ? "No walkable route to that fire." : "Add a fire first, or place a Fire marker."}
                </p>
              )}
            </details>
          </>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[#17221b] px-4 py-2.5">
        <span className="flex gap-4">
          {step === 0 && <button className={linkBtn} onClick={onReset}>Reset points</button>}
          {step === 2 && linked && (
            <button className={linkBtn} onClick={() => void link.simulate(!link.simulating)}>
              {link.simulating ? "Stop demo walk" : "Start demo walk"}
            </button>
          )}
        </span>
        <FooterRight step={step} onNext={() => setStep((s) => Math.min(2, s + 1) as Step)} onSignOut={onSignOut} />
      </footer>
    </section>
  );
}

function FooterRight({ step, onNext, onSignOut }: { step: Step; onNext: () => void; onSignOut: () => void }): ReactNode {
  return step === 0 ? (
    <button className={btnPrimary} onClick={onNext}>Next</button>
  ) : (
    <button className={linkBtn} onClick={onSignOut}>Sign out</button>
  );
}
