import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import * as Updates from "expo-updates";
import { DevSettings, I18nManager } from "react-native";
import { startupLanguage } from "../features/settings/model";
import { STORAGE_KEYS } from "../platform/secure-storage";
import { decideReload, isRtlLanguage, parseReloadGuard, type DirectionLanguage } from "./direction";
import { DEFAULT_INTERPOLATION, resolveLocale, resources, type Locale } from "@outlet/i18n";

export function initialLocale(): Locale {
  return resolveLocale(getLocales()[0]?.languageCode);
}

const DIRECTION_GUARD_KEY = "outlet.direction.reload";

/** Minimal storage surface the direction logic needs (SecureStorage satisfies it). */
export interface DirectionStorage {
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

type ApplyListener = () => void;
let applying = false;
const listeners = new Set<ApplyListener>();
function setApplying(v: boolean): void {
  applying = v;
  listeners.forEach((l) => l());
}
/** useSyncExternalStore pair for the branded "Applying language..." overlay. */
export const languageApplying = {
  subscribe(l: ApplyListener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
  get(): boolean { return applying; },
};

async function reloadApp(): Promise<boolean> {
  // Development (Expo Go / dev client): the JS-only dev reload is the one that keeps native modules registered.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    try {
      DevSettings.reload();
      return true;
    } catch {
      // fall through to expo-updates
    }
  }
  try {
    await Updates.reloadAsync();
    return true;
  } catch {
    return false; // Not available in this runtime: direction applies on the next launch.
  }
}

async function readGuard(storage: DirectionStorage): Promise<DirectionLanguage | null> {
  try { return parseReloadGuard(await storage.getString(DIRECTION_GUARD_KEY)); } catch { return null; }
}
async function writeGuard(storage: DirectionStorage, g: DirectionLanguage | null): Promise<void> {
  try {
    if (g === null) await storage.remove(DIRECTION_GUARD_KEY);
    else await storage.setString(DIRECTION_GUARD_KEY, g);
  } catch {
    // Guard is best-effort; the worst case is one extra reload attempt.
  }
}

export type DirectionOutcome = "ready" | "reloading" | "gave_up";

/**
 * Makes the native layout direction match `lang`. Must run before the first render of the app tree.
 * Sets allow/force flags every time (cheap, idempotent) and reloads at most once per language.
 */
export async function settleDirection(lang: DirectionLanguage, storage: DirectionStorage): Promise<DirectionOutcome> {
  const rtl = isRtlLanguage(lang);
  I18nManager.allowRTL(rtl);
  const decision = decideReload(lang, I18nManager.isRTL, await readGuard(storage));
  if (decision.action === "none") {
    await writeGuard(storage, null);
    return "ready";
  }
  if (decision.action === "give_up") {
    await writeGuard(storage, null);
    return "gave_up";
  }
  I18nManager.forceRTL(rtl);
  await writeGuard(storage, decision.nextGuard);
  return (await reloadApp()) ? "reloading" : "gave_up";
}

/** Launch path: saved language, else device language; direction settled before the caller renders. */
export async function bootLanguage(device: Locale, storage: DirectionStorage): Promise<DirectionOutcome> {
  let stored: string | null = null;
  try { stored = await storage.getString(STORAGE_KEYS.localePreference); } catch { /* fall back to device */ }
  const lang = startupLanguage(stored, device);
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
  return settleDirection(lang, storage);
}

/**
 * In-app language change: persist, then apply direction, reloading immediately when it flips. While that
 * happens the branded overlay covers the app so no half-applied state is ever visible.
 * Returns "ready" when the language was applied in place (same direction), otherwise the app is reloading.
 */
export async function applyLanguage(lang: Locale, storage: DirectionStorage): Promise<DirectionOutcome> {
  setApplying(true);
  let outcome: DirectionOutcome = "gave_up";
  try {
    try { await storage.setString(STORAGE_KEYS.localePreference, lang); } catch { /* best-effort; device language applies next launch */ }
    await writeGuard(storage, null);
    outcome = await settleDirection(lang, storage);
    if (outcome !== "reloading") await i18n.changeLanguage(lang);
    return outcome;
  } finally {
    // On "reloading" the process is replaced, so the overlay stays up until then.
    if (outcome !== "reloading") setApplying(false);
  }
}

export function setupI18n(locale: Locale): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      lng: locale,
      fallbackLng: "ar",
      resources: {
        ar: { translation: resources.ar },
        en: { translation: resources.en },
      },
      interpolation: { escapeValue: false, defaultVariables: { ...DEFAULT_INTERPOLATION } },
      returnNull: false,
    });
  } else {
    // Fast Refresh and OTA reloads keep the already-initialised singleton alive, so catalog keys added
    // after first init would render as raw keys. Re-apply the bundles so new namespaces always resolve.
    i18n.addResourceBundle("ar", "translation", resources.ar, true, true);
    i18n.addResourceBundle("en", "translation", resources.en, true, true);
  }
  return i18n;
}
