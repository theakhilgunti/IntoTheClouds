"use client";
/** Calls POST /api/scan and reads the streamed progress events. */
import type { ScanEvent, ScanResult } from "./sources";

export async function streamScan(
  form: FormData,
  onEvent: (e: ScanEvent) => void,
  signal?: AbortSignal,
): Promise<{ result: ScanResult; cached: boolean }> {
  const res = await fetch("/api/scan", { method: "POST", body: form, signal });
  if (!res.ok || !res.body) throw new Error("The scan service isn't responding. Please try again.");
  const reader = res.body.getReader();
  const onAbort = () => {
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const dec = new TextDecoder();
  let buf = "";
  let final: { result: ScanResult; cached: boolean } | null = null;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const e = JSON.parse(line) as ScanEvent;
        if (e.type === "error") throw new Error(e.message);
        if (e.type === "result") final = { result: e.result, cached: e.cached };
        onEvent(e);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!final) throw new Error("The scan stopped before finishing. Please try again.");
  return final;
}
