/** Pure logic for the shared language and theme toggle. No storage here: the theme provider and applyLanguage own persistence. */
import type { ThemeChoice } from "../settings/model";

export type { ThemeChoice };

/** Pill segments: sun, moon. There is no "system" segment. */
export type ThemeSegment = "light" | "dark";
export const THEME_SEGMENTS: readonly ThemeSegment[] = ["light", "dark"];
const THEME_ICON = { light: "sunny", dark: "moon" } as const;
export const themeSegmentIcon = (p: ThemeSegment): (typeof THEME_ICON)[ThemeSegment] => THEME_ICON[p];

/** The button always names the OTHER language, in that language's own script. */
export type UiLocale = "ar" | "en";
export const otherLocale = (current: string): UiLocale => (current.startsWith("en") ? "ar" : "en");
export const LOCALE_NATIVE_NAME: Readonly<Record<UiLocale, string>> = { ar: "العربية", en: "English" };
