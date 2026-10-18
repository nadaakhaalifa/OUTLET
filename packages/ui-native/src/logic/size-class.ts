// Size classes and the iPad zoom (IPAD_ZOOM is the maximum zoom) (docs/specs/ipad-adaptation.md, ADR-0054). Pure: no React, no react-native.
// Compact (every iPhone, z = 1) must return the unzoomed tokens untouched; every function short-circuits on z <= 1.
import {
  adaptiveGrid, CONTROL_ZOOM_SHARE, contentMaxWidth, expandedMinEffectiveWidth, controlSize, formSheet, iphoneEffectiveWidth, layoutMetrics, minTouchTarget, radius, sizeClassBreakpoints,
  spacing, tabBarMaxWidth, toastMaxWidth, twoPaneMinContentWidth, zoom,
} from "@outlet/ui-tokens";
import { MAX_FONT_SCALE } from "./touch";

export type SizeClass = "compact" | "regular" | "expanded";
export type ContentWidthKind = "form" | "reading" | "grid" | "full";
export type GridPreference = 1 | 2 | 3 | 4;
export type PaneLayout = "single" | "two";

function finiteWidth(w: number): number {
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * The zoom in force for a WINDOW width, in [1, IPAD_ZOOM], continuous and monotonic non-decreasing in the width:
 * 1 below 600 pt (every iPhone, Slide Over, 1/3 Split View), then 1 + (w - 600) / 375 up to IPAD_ZOOM. So a 600 pt window
 * has z = 1 (no jump across the class boundary) and no window is ever laid out narrower than an iPhone (w / z >= 375).
 * Rounded to 0.01 so a resize rebuilds the theme at most once per 0.01 step, and never inside the plateau.
 */
export function zoomForWidth(windowWidth: number): number {
  const w = finiteWidth(windowWidth);
  if (w < sizeClassBreakpoints.regular) return 1;
  const raw = 1 + (w - sizeClassBreakpoints.regular) / iphoneEffectiveWidth;
  return raw >= zoom ? zoom : Math.round(raw * 100) / 100;
}

/** Class from the WINDOW width (Split View, Slide Over and Stage Manager report the app window, never the device). */
export function sizeClassFor(windowWidth: number): SizeClass {
  const w = finiteWidth(windowWidth);
  if (w < sizeClassBreakpoints.regular) return "compact";
  return w / zoomForWidth(w) >= expandedMinEffectiveWidth ? "expanded" : "regular";
}

/** Zoom for control heights and icon glyphs: CONTROL_ZOOM (derived) on zoomed classes. Scales with the base zoom `z`. */
export function controlZoomFor(z: number): number {
  return z <= 1 ? 1 : 1 + (z - 1) * CONTROL_ZOOM_SHARE;
}

/** Width layout is computed in: window / z(window). */
export function effectiveWidth(windowWidth: number): number {
  return finiteWidth(windowWidth) / zoomForWidth(windowWidth);
}

/** round(n * z): spacing, radii, icons, shadows. Identity at z <= 1. */
export function zoomRound(n: number, z: number): number {
  return z <= 1 ? n : Math.round(n * z);
}
/** Round to the nearest even number: control heights. Identity at z <= 1. */
export function roundEven(n: number): number {
  return Math.round(n / 2) * 2;
}
export function zoomEven(n: number, z: number): number {
  return z <= 1 ? n : roundEven(n * z);
}
/** Round to the nearest 0.5, a tie going to the even half-step (26.25 -> 26, 18.375 -> 18.5): font sizes. */
export function roundHalf(n: number): number {
  const x = n * 2;
  const f = Math.floor(x);
  const d = x - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return r / 2;
}

type Scaled<T> = { readonly [K in keyof T]: number };

export function zoomedSpacing(z: number): Scaled<typeof spacing> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(spacing)) out[k] = zoomRound(v, z);
  return out as Scaled<typeof spacing>;
}
/** `pill` is not scaled (it is "fully round"). */
export function zoomedRadii(z: number): Scaled<typeof radius> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(radius)) out[k] = k === "pill" ? v : zoomRound(v, z);
  return out as Scaled<typeof radius>;
}
export function zoomedControlSize(z: number): Scaled<typeof controlSize> {
  const out: Record<string, number> = {};
  const cz = controlZoomFor(z);
  for (const [k, v] of Object.entries(controlSize)) out[k] = zoomEven(v, cz);
  return out as Scaled<typeof controlSize>;
}

/**
 * Text zoom: the zoom in force (1 on compact). Dynamic Type is not faded: RN multiplies by min(fs, 2) on top, so the
 * rendered scale is T = z * min(fs, 2), never above 2z (WCAG 1.4.4: user text size keeps its full 2x effect) and never
 * below the phone size at the same setting.
 */
export function typeZoomFactor(z: number): number {
  return z <= 1 ? 1 : z;
}

/** Rendered text scale versus the phone size: T(fs) = z * min(fs, 2). Monotonic, <= 2z, >= min(fs, 2). */
export function renderedTextScale(fontScale: number, z: number): number {
  const fs = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return typeZoomFactor(z) * Math.min(fs, MAX_FONT_SCALE);
}

export interface BaseTextMetrics { readonly fontSize: number; readonly lineHeight: number; readonly letterSpacing: number }

/** fontSize round-half, lineHeight round-even, tracking scales with k. Returns the input unchanged when k = 1. */
export function zoomedTextMetrics(base: BaseTextMetrics, z: number): BaseTextMetrics {
  const k = typeZoomFactor(z);
  if (k === 1) return base;
  return { fontSize: roundHalf(base.fontSize * k), lineHeight: roundEven(base.lineHeight * k), letterSpacing: base.letterSpacing * k };
}

/** hitSlop each side for a PHYSICAL visual size; zoomed controls are already >= 44, so they need none. */
export function slopForPhysical(visual: number): number {
  return Math.max(0, Math.ceil((minTouchTarget - visual) / 2));
}

/** Everything that depends only on the size class, the zoom in force and the font scale (stable across resizes inside a step). */
export interface ZoomInfo {
  readonly sizeClass: SizeClass;
  readonly z: number;
  /** Control and icon zoom: 1 + (z - 1) * CONTROL_ZOOM_SHARE. */
  readonly controlZ: number;
  readonly fontScale: number;
  /** Side gutter, physical pt (round(effective * z)). */
  readonly gutter: number;
  readonly sectionGap: number;
  readonly gridGap: number;
  /** Scale a number by z (spacing, radii, art): round(n * z). */
  readonly s: (n: number) => number;
  /** Scale a control height or icon glyph by controlZ. */
  readonly sc: (n: number) => number;
}

/** ZoomInfo plus the window measurements (changes on every resize; lives in its own context). */
export interface LayoutInfo extends ZoomInfo {
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** window / z */
  readonly effectiveWidth: number;
  /** Effective content width: (window - 2 * physical gutter) / z. The number layout decisions use. */
  readonly contentWidth: number;
  readonly paneLayout: PaneLayout;
}

/** Memo key of everything in ZoomInfo: equal keys mean an equal theme (a resize inside one step must not rebuild it). */
export function zoomKey(windowWidth: number, fontScale: number): string {
  const fs = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return `${sizeClassFor(windowWidth)}|${zoomForWidth(windowWidth)}|${fs}`;
}

export function zoomInfoFor(windowWidth: number, fontScale = 1): ZoomInfo {
  const w = finiteWidth(windowWidth);
  const sizeClass = sizeClassFor(w);
  const z = zoomForWidth(w);
  const cz = controlZoomFor(z);
  const m = layoutMetrics[sizeClass];
  return {
    sizeClass, z, controlZ: cz, fontScale: Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1,
    gutter: zoomRound(m.gutter, z), sectionGap: zoomRound(m.sectionGap, z), gridGap: zoomRound(m.gridGap, z),
    s: (n: number) => zoomRound(n, z), sc: (n: number) => zoomRound(n, cz),
  };
}

export function layoutFor(windowWidth: number, fontScale = 1, windowHeight = 0): LayoutInfo {
  const w = finiteWidth(windowWidth);
  const zi = zoomInfoFor(w, fontScale);
  return {
    ...zi, windowWidth: w, windowHeight: finiteWidth(windowHeight), effectiveWidth: w / zi.z,
    contentWidth: Math.max(0, (w - 2 * zi.gutter) / zi.z), paneLayout: paneLayoutFor(w / zi.z),
  };
}

/** Two-pane only at effective WINDOW width >= 760 (window / z): the `expanded` class. */
export function paneLayoutFor(effectiveContentWidth: number): PaneLayout {
  return effectiveContentWidth >= twoPaneMinContentWidth ? "two" : "single";
}

/**
 * Content width (gutters excluded, physical) of the centred column: capped at contentMaxWidth[kind] effective points
 * (x z). `grid` and `full` are uncapped (the window caps them); compact has no cap (identical to today).
 */
export function contentColumnWidth(kind: ContentWidthKind, windowWidth: number): number {
  const li = layoutFor(windowWidth);
  const avail = Math.max(0, li.windowWidth - 2 * li.gutter);
  if (li.sizeClass === "compact" || kind === "full" || kind === "grid") return avail;
  return Math.min(avail, Math.round(contentMaxWidth[kind] * li.z));
}

/** Physical max width of the column box (content + gutters) for `Screen`, or null for no cap. */
export function columnMaxWidth(kind: ContentWidthKind, sizeClass: SizeClass, gutter: number, z: number): number | null {
  if (sizeClass === "compact" || kind === "full" || kind === "grid") return null;
  return Math.round(contentMaxWidth[kind] * z) + 2 * gutter;
}

/**
 * Physical width of the centred form sheet: min(420 eff, effective width - 2 gutters) * z, from an effective window of 460.
 * Null below that (compact and the narrowest zoomed windows): the zoomed bottom sheet.
 */
export function formSheetWidth(windowWidth: number): number | null {
  const li = layoutFor(windowWidth);
  if (li.sizeClass === "compact" || li.effectiveWidth < formSheet.minEffectiveWindow) return null;
  const eff = Math.min(formSheet.width, li.effectiveWidth - 2 * layoutMetrics[li.sizeClass].gutter);
  return Math.round(Math.max(0, eff) * li.z);
}

/** Max height of the form sheet (85% of the window height); the bottom sheet keeps its own ratio. */
export function formSheetMaxHeight(windowHeight: number): number {
  return Math.floor(finiteWidth(windowHeight) * formSheet.heightRatio);
}

/**
 * Extra height the zoomed tab bar needs beyond the compact `tabBarInset` the app layouts pass in TabBarInsetContext
 * (52 content points become round(52 * controlZ)). Screen and StickyBar add it, so the layouts need no change.
 */
export function tabBarZoomExtra(z: number): number {
  return zoomRound(52, controlZoomFor(z)) - 52;
}

/** Physical toast max width (384 effective) and floating tab bar max width. */
export function toastWidthCap(sizeClass: SizeClass, z: number): number | null {
  return sizeClass === "compact" ? null : Math.round(toastMaxWidth * z);
}
export function tabBarWidthCap(sizeClass: SizeClass, z: number): number | null {
  return sizeClass === "compact" ? null : Math.round(tabBarMaxWidth * z);
}

/** minCard grows with large text, mirroring grid-density `maxDensityForFontScale`: x1.25 at fs >= 1.3, x1.5 at fs >= 1.5. */
function minCardFor(base: number, fontScale: number): number {
  if (fontScale >= 1.5) return base * 1.5;
  if (fontScale >= 1.3) return base * 1.25;
  return base;
}

/**
 * Adaptive columns, all inputs in EFFECTIVE points. columns = clamp(floor((w + gap) / (minCard + gap)), 1, cap).
 * `w` is the grid's own width (gutters removed; the grid pane when a side panel is open).
 */
export function columnsFor(effectiveContentWidth: number, preference: GridPreference, fontScale = 1, gap: number = layoutMetrics.regular.gridGap): number {
  const w = finiteWidth(effectiveContentWidth);
  const fs = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const minCard = minCardFor(adaptiveGrid.minCard[preference], fs);
  const raw = Math.floor((w + gap) / (minCard + gap));
  return Math.min(adaptiveGrid.cap[preference], Math.max(1, raw));
}

/** Columns for a full-width grid screen from the WINDOW width (the window caps it). Regular/expanded only. */
export function gridColumnsForWindow(windowWidth: number, preference: GridPreference, fontScale = 1): number {
  const li = layoutFor(windowWidth, fontScale);
  return columnsFor(li.contentWidth, preference, fontScale, layoutMetrics[li.sizeClass].gridGap);
}
