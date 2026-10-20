/**
 * Pure logic for the cutout editor (no React, no router): stroke simplification, screen -> image coordinates under
 * zoom/pan, brush mapping, parameter clamping, undo/redo over version ids and the tool state machine.
 */
import type { CutoutBlock, RefineBackground, RefineParams, RefineStroke, StrokeMode } from "../model";

export const MAX_STROKES = 200;
export const MAX_POINTS = 2000;
/** Minimum distance between kept points, in image-normalised units (about 0.4% of the width). */
export const MIN_POINT_DISTANCE = 0.004;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
export const BRUSH_MIN_PX = 6;
export const BRUSH_MAX_PX = 64;
export const BRUSH_DEFAULT_PX = 24;
export const AUTO_APPLY_MS = 600;

export const DEFAULT_PARAMS: RefineParams = { featherPx: 1, smooth: 0.3, edgeShiftPx: 0, background: "transparent" };

export const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Clamps every parameter to its documented range (feather 0..4, smooth 0..1, edge -3..3 whole px). */
export function clampParams(p: RefineParams): RefineParams {
  const background: RefineBackground = p.background === "white" || p.background === "studio" ? p.background : "transparent";
  return {
    featherPx: Math.round(clamp(p.featherPx, 0, 4) * 10) / 10,
    smooth: Math.round(clamp(p.smooth, 0, 1) * 100) / 100,
    edgeShiftPx: Math.round(clamp(p.edgeShiftPx, -3, 3)),
    background,
  };
}
export const paramsEqual = (a: RefineParams, b: RefineParams): boolean =>
  a.featherPx === b.featherPx && a.smooth === b.smooth && a.edgeShiftPx === b.edgeShiftPx && a.background === b.background;

export interface Pt { readonly x: number; readonly y: number }

/** Drops points closer than `minDist` to the last kept one (always keeps first and last); caps at MAX_POINTS by even sampling. */
export function simplifyPoints(points: readonly Pt[], minDist: number = MIN_POINT_DISTANCE, max: number = MAX_POINTS): Pt[] {
  if (points.length <= 2) return [...points];
  const kept: Pt[] = [points[0] as Pt];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i] as Pt;
    const q = kept[kept.length - 1] as Pt;
    if (Math.hypot(p.x - q.x, p.y - q.y) >= minDist) kept.push(p);
  }
  kept.push(points[points.length - 1] as Pt);
  if (kept.length <= max) return kept;
  const out: Pt[] = [];
  for (let i = 0; i < max; i++) out.push(kept[Math.round((i * (kept.length - 1)) / (max - 1))] as Pt);
  return out;
}

export interface Size { readonly width: number; readonly height: number }
export interface Rect extends Size { readonly x: number; readonly y: number }
export interface ViewTransform { readonly scale: number; readonly tx: number; readonly ty: number }
export const IDENTITY_VIEW: ViewTransform = { scale: 1, tx: 0, ty: 0 };

/** The rectangle an image of `image` size occupies when contained (letterboxed) in `canvas`. */
export function fitRect(canvas: Size, image: Size): Rect {
  if (canvas.width <= 0 || canvas.height <= 0 || image.width <= 0 || image.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const k = Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * k, height = image.height * k;
  return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height };
}

/**
 * Canvas-local screen point -> image-normalised (0..1). The view transform scales about the canvas centre and then
 * translates by (tx, ty), which is exactly how the editor lays out its transformed layer.
 */
export function screenToImage(p: Pt, view: ViewTransform, canvas: Size, fit: Rect): Pt {
  if (fit.width <= 0 || fit.height <= 0) return { x: 0, y: 0 };
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const qx = (p.x - cx - view.tx) / view.scale + cx;
  const qy = (p.y - cy - view.ty) / view.scale + cy;
  return { x: (qx - fit.x) / fit.width, y: (qy - fit.y) / fit.height };
}
export const inImage = (p: Pt): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
export const clampUnit = (p: Pt): Pt => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) });

/** Brush radius (fraction of image width) for a brush drawn `brushPx` wide on screen at the given zoom. */
export function brushRadiusNorm(brushPx: number, scale: number, fitWidth: number): number {
  if (fitWidth <= 0 || scale <= 0) return 0;
  return clamp(brushPx / 2 / scale / fitWidth, 0, 0.5);
}

/** Pan limit: the zoomed canvas edge never moves inside the viewport. */
export function clampView(v: ViewTransform, canvas: Size): ViewTransform {
  const scale = clamp(v.scale, MIN_ZOOM, MAX_ZOOM);
  const mx = (canvas.width * (scale - 1)) / 2, my = (canvas.height * (scale - 1)) / 2;
  return { scale, tx: clamp(v.tx, -mx, mx), ty: clamp(v.ty, -my, my) };
}

/** Pinch about a focal point (canvas-local) given the scale ratio since the gesture began and the focal drag. */
export function pinchView(start: ViewTransform, ratio: number, focal: Pt, focalDelta: Pt, canvas: Size): ViewTransform {
  const scale = clamp(start.scale * ratio, MIN_ZOOM, MAX_ZOOM);
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const k = scale / start.scale;
  const tx = focal.x - cx - (focal.x - cx - start.tx) * k + focalDelta.x;
  const ty = focal.y - cy - (focal.y - cy - start.ty) * k + focalDelta.y;
  return clampView({ scale, tx, ty }, canvas);
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;

/** A finished stroke, ready for the port: simplified, clamped to the image and rounded; null when it has no points. */
export function buildStroke(mode: StrokeMode, points: readonly Pt[], radius: number): RefineStroke | null {
  if (points.length === 0) return null;
  const pts = simplifyPoints(points.map(clampUnit)).map((p): readonly [number, number] => [r4(p.x), r4(p.y)]);
  return { mode, radius: r4(clamp(radius, 0.001, 0.5)), points: pts };
}

export function addStroke(list: readonly RefineStroke[], s: RefineStroke): { strokes: readonly RefineStroke[]; capped: boolean } {
  if (list.length >= MAX_STROKES) return { strokes: list, capped: true };
  return { strokes: [...list, s], capped: false };
}

/** Linear history of version ids with a cursor. `present` is the id currently shown. */
export interface History { readonly ids: readonly number[]; readonly cursor: number }
export const historyOf = (ids: readonly number[], present?: number): History => {
  const i = present === undefined ? ids.length - 1 : ids.indexOf(present);
  return { ids, cursor: Math.max(0, i) };
};
export const presentOf = (h: History): number | null => h.ids[h.cursor] ?? null;
export const canUndo = (h: History): boolean => h.cursor > 0;
export const canRedo = (h: History): boolean => h.cursor < h.ids.length - 1;
export const undo = (h: History): History => (canUndo(h) ? { ids: h.ids, cursor: h.cursor - 1 } : h);
export const redo = (h: History): History => (canRedo(h) ? { ids: h.ids, cursor: h.cursor + 1 } : h);
/** A new edit drops any redo tail, then becomes the present. */
export const pushVersion = (h: History, id: number): History => {
  const ids = [...h.ids.slice(0, h.cursor + 1), id];
  return { ids, cursor: ids.length - 1 };
};
export const resetToFirst = (h: History): History => ({ ids: h.ids, cursor: 0 });

export type Tool = "move" | "erase" | "restore";
export interface EditorState {
  readonly tool: Tool;
  readonly drawing: boolean;
  readonly applying: boolean;
  /** Editing disabled: sidecar down, not configured, disabled. */
  readonly locked: boolean;
}
export type EditorEvent =
  | { type: "tool"; tool: Tool }
  | { type: "strokeStart" }
  | { type: "strokeEnd" }
  | { type: "applyStart" }
  | { type: "applyDone" }
  | { type: "lock" };
export const INITIAL_EDITOR: EditorState = { tool: "erase", drawing: false, applying: false, locked: false };

export function editorReducer(s: EditorState, e: EditorEvent): EditorState {
  switch (e.type) {
    case "tool": return s.drawing ? s : { ...s, tool: e.tool };
    case "strokeStart": return s.locked || s.applying || s.tool === "move" ? s : { ...s, drawing: true };
    case "strokeEnd": return s.drawing ? { ...s, drawing: false } : s;
    case "applyStart": return s.locked ? s : { ...s, applying: true, drawing: false };
    case "applyDone": return { ...s, applying: false };
    case "lock": return { ...s, locked: true, drawing: false, applying: false };
  }
}

/** Blocks after which editing cannot continue at all (the original/cutout already shown is still usable). */
export const EDIT_LOCKED: readonly CutoutBlock[] = ["disabled", "not_configured", "service_down", "model_missing", "offline", "session_expired", "consent"];
export const isEditLocked = (b: CutoutBlock | null): boolean => b !== null && EDIT_LOCKED.includes(b);

/** i18n key suffix under `brandMode.cutout.block` (or "unavailable") for a block shown in the editor. */
export function blockMessageKey(b: CutoutBlock): string {
  switch (b) {
    case "disabled": case "not_configured": return "unavailable";
    case "too_large": return "block.tooLarge";
    case "service_down": return "block.serviceDown";
    case "model_missing": return "block.modelMissing";
    case "quota": case "consent": case "attempts": case "offline": case "busy": case "timeout": return `block.${b}`;
    default: return "failed";
  }
}

/** The review is offered first unless the seller already confirmed it and the score is high (spec: score < 85 or not reviewed). */
export const REVIEW_SCORE = 85;
export function needsReview(score: number | null, reviewed: boolean): boolean {
  return score === null || score < REVIEW_SCORE || !reviewed;
}
