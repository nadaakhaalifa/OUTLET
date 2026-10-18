import { MAX_PARAMS_BYTES, REFINE_LIMITS } from "./ports";
import type { ProductMediaVersion, RefineBackground, RefineRequest, RefineStroke } from "./ports";

/** Strokes are quantised to 1/1000 of the frame so a version's params stay small and reproducible. */
const Q = 1000;
const q = (v: number): number => Math.min(Q, Math.max(0, Math.round(v * Q)));

export interface CompactStroke {
  /** "e" erase, "r" restore */
  readonly m: "e" | "r";
  /** radius * 1000, 1..250 */
  readonly r: number;
  /** x0, y0, x1, y1 ... each 0..1000 */
  readonly p: readonly number[];
}

export interface EditSettings {
  readonly strokes: readonly RefineStroke[];
  readonly featherPx: number;
  readonly smooth: number;
  readonly edgeShiftPx: number;
  readonly background: RefineBackground;
}

/** Rounds every coordinate and radius to the stored precision (what is stored is exactly what is sent to the sidecar). */
export function quantizeStrokes(strokes: readonly RefineStroke[]): RefineStroke[] {
  return strokes.map((s) => ({
    mode: s.mode,
    radius: Math.min(REFINE_LIMITS.maxRadius * Q, Math.max(1, Math.round(s.radius * Q))) / Q,
    points: s.points.map((p) => [q(p[0]) / Q, q(p[1]) / Q] as const),
  }));
}

export function compactParams(
  s: EditSettings,
  extra: { readonly baseVersion: number },
): { readonly strokes: readonly CompactStroke[]; readonly featherPx: number; readonly smooth: number; readonly edgeShiftPx: number; readonly background: RefineBackground; readonly fromVersion: number } {
  return {
    strokes: s.strokes.map((st) => ({
      m: st.mode === "erase" ? "e" : "r",
      r: Math.round(st.radius * Q),
      p: st.points.flatMap((p) => [q(p[0]), q(p[1])]),
    })),
    featherPx: s.featherPx,
    smooth: s.smooth,
    edgeShiftPx: s.edgeShiftPx,
    background: s.background,
    fromVersion: extra.baseVersion,
  };
}

export const paramsBytes = (params: unknown): number => new TextEncoder().encode(JSON.stringify(params)).length;
export const paramsFit = (params: unknown): boolean => paramsBytes(params) <= MAX_PARAMS_BYTES;

export function toRefineRequest(mask: Uint8Array | null, s: EditSettings): RefineRequest {
  return { mask, strokes: s.strokes, featherPx: s.featherPx, smooth: s.smooth, edgeShiftPx: s.edgeShiftPx, background: s.background };
}

/** Next free edit version number for a job. */
export const nextVersionNumber = (versions: readonly Pick<ProductMediaVersion, "version">[]): number =>
  versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;

/** Oldest-first versions to drop so that at most `keep` remain, never the current one. */
export function versionsToPrune(versions: readonly ProductMediaVersion[], keep: number, current: number): readonly ProductMediaVersion[] {
  const excess = versions.length - keep;
  if (excess <= 0) return [];
  return [...versions].sort((a, b) => a.version - b.version).filter((v) => v.version !== current).slice(0, excess);
}
