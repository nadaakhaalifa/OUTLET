import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import * as Updates from "expo-updates";
import { I18nManager } from "react-native";
import { isRtl, resolveLocale, resources, type Locale } from "@outlet/i18n";

export function initialLocale(): Locale {
  return resolveLocale(getLocales()[0]?.languageCode);
}

/**
 * Applies layout direction for the locale. React Native only picks up a direction
 * change after a reload, so a mismatch triggers one. In Expo Go or a dev client the
 * reload can be unavailable, in which case the user reloads manually.
 */
export async function applyDirection(locale: Locale): Promise<void> {
  const rtl = isRtl(locale);
  I18nManager.allowRTL(rtl);
  if (I18nManager.isRTL === rtl) return;
  I18nManager.forceRTL(rtl);
  try {
    await Updates.reloadAsync();
  } catch {
    // Reload unavailable in this runtime; direction applies on next launch.
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
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  }
  return i18n;
}
