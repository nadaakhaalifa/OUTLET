import type { ColorTokens } from "@outlet/ui-tokens";

export type ThemePreference = "system" | "light" | "dark";
export function resolveScheme(pref: ThemePreference, system: "light" | "dark" | null | undefined): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return system === "dark" ? "dark" : "light";
}
export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** Motion duration honouring Reduce Motion (0 = no animation). */
export function motionDuration(reduceMotion: boolean, ms: number): number {
  return reduceMotion ? 0 : ms;
}

export function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
}
export function progressRatio(current: number, target: number): number {
  return target <= 0 ? 1 : clamp01(current / target);
}

export type BadgeKind = "verified" | "lowest30" | "launch" | "sponsored" | "live" | "plus" | "neutral";
export interface BadgeView { readonly fg: keyof ColorTokens; readonly bg: keyof ColorTokens | null; readonly border: keyof ColorTokens | null; readonly dot: keyof ColorTokens | null; readonly icon: string | null }
/** Badges are quiet: coloured text, optional hairline. Colour roles are fixed by meaning. */
export function badgeView(kind: BadgeKind): BadgeView {
  switch (kind) {
    case "verified": return { fg: "savings", bg: null, border: "savings", dot: null, icon: "checkmark-circle" };
    case "lowest30": return { fg: "savings", bg: null, border: null, dot: null, icon: "trending-down" };
    case "launch": return { fg: "textPrimary", bg: "fill", border: null, dot: null, icon: null };
    case "sponsored": return { fg: "textSecondary", bg: null, border: "hairline", dot: null, icon: null };
    case "live": return { fg: "textPrimary", bg: null, border: "hairline", dot: "danger", icon: null };
    case "plus": return { fg: "plus", bg: null, border: "plus", dot: null, icon: "sparkles" };
    case "neutral": return { fg: "textPrimary", bg: "fill", border: null, dot: null, icon: null };
  }
}

export type SizeCellState = "available" | "unavailable" | "selected";
export interface SizeCellView { readonly strike: boolean; readonly filled: boolean; readonly ring: boolean; readonly interactive: boolean; readonly opacity: number }
export function sizeCellView(i: { available: boolean; selected: boolean; yours: boolean }): SizeCellView {
  return {
    strike: !i.available,
    filled: i.available && i.selected,
    ring: i.yours && !i.selected,
    interactive: i.available,
    opacity: i.available ? 1 : 0.4,
  };
}

/** Quantity bounds: returns the next value or null if the step is not allowed. */
export function stepQuantity(value: number, delta: 1 | -1, min: number, max: number): number | null {
  const next = value + delta;
  return next < min || next > max ? null : next;
}

/** Rating only renders with real data: a finite value in [0,5] and a positive integer count. */
export function ratingView(value: number | null | undefined, count: number | null | undefined): { show: boolean; filled: number; half: boolean } {
  if (value === null || value === undefined || count === null || count === undefined || !Number.isFinite(value) || value < 0 || value > 5 || !Number.isInteger(count) || count <= 0) return { show: false, filled: 0, half: false };
  const rounded = Math.round(value * 2) / 2;
  return { show: true, filled: Math.floor(rounded), half: rounded % 1 !== 0 };
}

/** Initials for an Avatar: first letters of up to two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => Array.from(w)[0] ?? "").join("").toUpperCase();
}

/** Docked tab bar: content height above the home indicator (the bar itself extends under the safe area). */
export const TAB_BAR_CONTENT_HEIGHT = 52;
export const TAB_BAR_FLOAT_GAP = 0;
/** The bar is flush with the screen bottom. */
export function tabBarBottomOffset(_bottomInset: number): number {
  return 0;
}
/** The board bar keeps only ~40% of the home-indicator inset as padding (the indicator overlaps the bar). */
export function tabBarBottomPad(bottomInset: number): number {
  return Math.round(Math.max(bottomInset, 0) * 0.4);
}
/** Space scenes reserve at the bottom so nothing hides behind the bar. */
export function tabBarInset(bottomInset: number): number {
  return TAB_BAR_CONTENT_HEIGHT + tabBarBottomPad(bottomInset) + TAB_BAR_FLOAT_GAP;
}
/** Badge text for the bag count: hidden at 0 (null), capped at "99+". */
export function tabBadgeText(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

export type ToastKind = "info" | "success" | "error";
