import { minTouchTarget, spacing } from "@outlet/ui-tokens";

/** Largest font scale we honour so layouts stay usable; text still grows with dynamic type. */
export const MAX_FONT_SCALE = 2;

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(scale, MAX_FONT_SCALE);
}

/** Scale a point size with the user's font scale, never below the base size. */
export function scaleSize(base: number, fontScale: number): number {
  return Math.round(base * Math.max(1, clampFontScale(fontScale)));
}

/** Minimum height of an interactive control: at least 44pt and grows with text. */
export function controlMinHeight(contentHeight: number, fontScale: number): number {
  const padded = scaleSize(contentHeight, fontScale) + spacing.md * 2;
  return Math.max(minTouchTarget, padded);
}

/** hitSlop needed to lift a visual size to the 44pt minimum. */
export function hitSlopFor(width: number, height: number): { top: number; bottom: number; start: number; end: number } {
  const v = Math.max(0, Math.ceil((minTouchTarget - height) / 2));
  const h = Math.max(0, Math.ceil((minTouchTarget - width) / 2));
  return { top: v, bottom: v, start: h, end: h };
}
