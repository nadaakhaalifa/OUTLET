/** Settings view models. Pure: language, theme and notification preference choices. */
import type { ConsentItem } from "../privacy-center/model";

export const LANGUAGES = ["ar", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const THEMES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEMES)[number];

/** Notification preferences are the marketing consents: off unless the person turned them on. Transactional messages are not optional. */
export const NOTIFICATION_PURPOSES = ["marketing_push", "marketing_whatsapp", "marketing_email"] as const;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];

export function languageIndex(lang: string): number {
  return lang.startsWith("en") ? 1 : 0;
}
export const languageAt = (i: number): Language => (i === 1 ? "en" : "ar");
export const themeIndex = (p: ThemeChoice): number => THEMES.indexOf(p);
export const themeAt = (i: number): ThemeChoice => THEMES[i] ?? "system";

/** Never pre-ticked: a purpose missing from the snapshot reads as off. */
export function notificationState(consents: readonly ConsentItem[]): Readonly<Record<NotificationPurpose, boolean>> {
  const on = (p: NotificationPurpose) => consents.some((c) => c.purpose === p && c.granted);
  return { marketing_push: on("marketing_push"), marketing_whatsapp: on("marketing_whatsapp"), marketing_email: on("marketing_email") };
}

/** A stored language preference is trusted only when it is exactly one of the supported languages. */
export function parseStoredLanguage(raw: string | null): Language | null {
  return raw === "ar" || raw === "en" ? raw : null;
}

/** Startup language: the person's saved choice wins, then the device language (Arabic by default). */
export function startupLanguage(stored: string | null, device: Language): Language {
  return parseStoredLanguage(stored) ?? device;
}

/** True when the layout direction must be changed (and the app reloaded) for `lang`. */
export function directionReloadNeeded(lang: Language, currentIsRtl: boolean): boolean {
  return (lang === "ar") !== currentIsRtl;
}
