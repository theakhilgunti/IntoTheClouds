"use client";

/**
 * Google Photorealistic 3D Tiles underlay via Cesium CDN.
 * On failure, calls onFail so the viewer can fall back to terrain-style shell.
 */
import { useEffect, useRef, useState } from "react";

type TilesStatus =
  | { ok: true; tilesetUrl: string }
  | { ok: false; reason: string };

type CesiumViewer = {
  scene: {
    globe: { show: boolean };
    skyAtmosphere?: { show: boolean };
    skyBox?: { show: boolean };
    backgroundColor: { red: number; green: number; blue: number; alpha: number };
    primitives: { add: (p: unknown) => unknown };
    camera: {
      lookAt: (target: unknown, offset: unknown) => void;
    };
  };
  imageryLayers: { removeAll: () => void };
  destroy: () => void;
};

declare global {
  interface Window {
    Cesium?: {
      Viewer: new (el: HTMLElement, opts: Record<string, unknown>) => CesiumViewer;
      Cesium3DTileset: { fromUrl: (url: string) => Promise<unknown> };
      Cartesian3: { fromDegrees: (lng: number, lat: number, h?: number) => unknown };
      Color: { fromCssColorString: (s: string) => { red: number; green: number; blue: number; alpha: number } };
      Math: { toRadians: (d: number) => number };
      HeadingPitchRange: new (h: number, p: number, r: number) => unknown;
    };
  }
}

let cesiumLoading: Promise<void> | null = null;

function loadCesium(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.Cesium) return Promise.resolve();
  if (cesiumLoading) return cesiumLoading;
  cesiumLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cesium.com/downloads/cesiumjs/releases/1.125/Build/Cesium/Widgets/widgets.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cesium.com/downloads/cesiumjs/releases/1.125/Build/Cesium/Cesium.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Cesium"));
    document.head.appendChild(script);
  });
  return cesiumLoading;
}

export default function PhotorealTiles({
  lat,
  lng,
  opacity,
  enabled,
  viewRangeM = 120,
  headingRad = 0,
  stories = 2,
  onFail,
}: {
  lat: number;
  lng: number;
  opacity: number;
  enabled: boolean;
  /** Approximate orbit distance in meters from footprint size. */
  viewRangeM?: number;
  /** Cesium camera heading in radians from north (0 = north). */
  headingRad?: number;
  /** Floors above grade; frames orbit distance and look-at height. */
  stories?: number;
  onFail?: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TilesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failedRef = useRef(false);

  useEffect(() => {
    let cancel = false;
    fetch("/api/tiles/status")
      .then((r) => r.json())
      .then((j: TilesStatus) => {
        if (cancel) return;
        setStatus(j);
        if (!j.ok && !failedRef.current) {
          failedRef.current = true;
          onFail?.(j.reason);
        }
      })
      .catch(() => {
        if (cancel) return;
        const reason = "Could not reach tiles status API.";
        setStatus({ ok: false, reason });
        if (!failedRef.current) {
          failedRef.current = true;
          onFail?.(reason);
        }
      });
    return () => {
      cancel = true;
    };
  }, [onFail]);

  useEffect(() => {
    if (!enabled || opacity <= 0.01 || !status?.ok || !host.current) return;
    let viewer: CesiumViewer | null = null;
    let cancel = false;
    (async () => {
      try {
        await loadCesium();
        if (cancel || !host.current || !window.Cesium) return;
        const C = window.Cesium;
        viewer = new C.Viewer(host.current, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          imageryProvider: false,
          terrain: undefined,
          requestRenderMode: true,
          contextOptions: { webgl: { alpha: true } },
        });
        viewer.scene.globe.show = false;
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
        if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
        viewer.scene.backgroundColor = C.Color.fromCssColorString("rgba(0,0,0,0)");
        viewer.imageryLayers.removeAll();
        const tileset = await C.Cesium3DTileset.fromUrl(status.tilesetUrl);
        viewer.scene.primitives.add(tileset);
        const rangeMult = stories >= 4 ? 2.8 : 2.2;
        const range = Math.max(70, Math.min(480, viewRangeM * rangeMult));
        const targetHeight = Math.max(12, stories * 2.75 * 0.55);
        const target = C.Cartesian3.fromDegrees(lng, lat, targetHeight);
        viewer.scene.camera.lookAt(
          target,
          new C.HeadingPitchRange(headingRad, C.Math.toRadians(-38), range),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (!cancel) {
          setError(reason);
          if (!failedRef.current) {
            failedRef.current = true;
            onFail?.(reason);
          }
        }
      }
    })();
    return () => {
      cancel = true;
      viewer?.destroy();
    };
  }, [enabled, opacity, status, lat, lng, viewRangeM, headingRad, stories, onFail]);

  if (!enabled) return null;

  if (status && !status.ok) {
    return (
      <div className="pointer-events-none absolute bottom-24 left-3 z-10 max-w-xs border border-bp-ink/40 bg-bp-deep/90 px-2 py-1 font-data text-[10px] text-bp-line">
        City mesh off — terrain style active. {status.reason}
      </div>
    );
  }

  if (error) {
    return (
      <div className="pointer-events-none absolute bottom-24 left-3 z-10 max-w-xs border border-bp-ink/40 bg-bp-deep/90 px-2 py-1 font-data text-[10px] text-bp-line">
        City mesh failed — terrain style active. {error} If this is HTTP 400, allow localhost on the Map Tiles API key referrers.
      </div>
    );
  }

  return (
    <div
      ref={host}
      className="pointer-events-none absolute inset-0 z-0 [&_.cesium-viewer-bottom]:hidden [&_.cesium-viewer-toolbar]:hidden [&_.cesium-credit-logoContainer]:hidden [&_.cesium-credit-textContainer]:hidden"
      style={{ opacity, visibility: opacity > 0.01 ? "visible" : "hidden" }}
      aria-hidden
    />
  );
}

export function useTilesAvailable(): { available: boolean; reason: string; ready: boolean } {
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState("Checking…");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fetch("/api/tiles/status")
      .then((r) => r.json())
      .then((j: TilesStatus) => {
        setAvailable(j.ok);
        setReason(j.ok ? "Google Photorealistic 3D Tiles ready" : j.reason);
        setReady(true);
      })
      .catch(() => {
        setAvailable(false);
        setReason("Tiles status unreachable");
        setReady(true);
      });
  }, []);
  return { available, reason, ready };
}
