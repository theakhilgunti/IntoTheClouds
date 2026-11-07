/** Shared result types: what the scan used, so the UI can show it. */
import type { BuildingModel } from "@/packages/schema/building-model";

export type SourceStatus = "used" | "skipped" | "failed";

export type SourceReport = {
  id: string;
  name: string;
  status: SourceStatus;
  /** What we asked it / what it gave us. */
  detail: string;
};

export type AttributeReport = {
  field: string;
  value: string;
  /** Where the value came from. "estimated" = nothing told us, so a typical value was used. */
  from: "map" | "photos" | "footprint" | "estimated";
  note?: string;
};

export type ScanResult = {
  model: BuildingModel;
  sources: SourceReport[];
  attributes: AttributeReport[];
  warnings: string[];
  /** Images the scan looked at, as data: URLs. */
  images: { label: string; url: string }[];
  summary: { width: number; depth: number; area: number; facing: string; stories: number };
  createdAt: string;
};

/** Lines streamed from POST /api/scan (one JSON object per line). */
export type ScanEvent =
  | { type: "step"; key: StepKey; status: "active" | "done" | "skipped"; detail?: string }
  | { type: "result"; result: ScanResult; cached: boolean }
  | { type: "error"; message: string };

export type StepKey = "locate" | "outline" | "imagery" | "vision" | "build";

export const STEP_LABELS: Record<StepKey, string> = {
  locate: "Locating the address",
  outline: "Tracing the building outline",
  imagery: "Pulling aerial imagery",
  vision: "Reading the house from the photos",
  build: "Building the 3D model",
};
