"use client";

import dynamic from "next/dynamic";
import type { BuildingModel } from "@/packages/schema/building-model";

// WebGL only runs in the browser.
const Viewer = dynamic(() => import("@/components/viewer/Viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-yellow-400">Loading 3D model…</div>
  ),
});

export default function ViewerClient({ model }: { model: BuildingModel }) {
  return <Viewer model={model} />;
}
