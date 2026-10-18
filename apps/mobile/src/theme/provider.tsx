import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ThemeProvider, parseThemePreference, type ThemePreference } from "@outlet/ui-native";
import { isRtl, resolveLocale } from "@outlet/i18n";
import { useServices } from "../state/services";

/** Storage key for the manual light/dark override. Not personal data. */
export const THEME_PREFERENCE_KEY = "ui.theme";

/** Theme provider wired to the app: locale direction, fonts, and a persisted light/dark/system override. */
export function AppThemeProvider(props: { fontsLoaded: boolean; children: ReactNode }) {
  const { storage } = useServices();
  const { i18n, t } = useTranslation();
  const labels = useMemo(() => ({ back: t("common.back") }), [t, i18n.language]);
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    let alive = true;
    storage.getString(THEME_PREFERENCE_KEY).then(
      (raw) => { if (alive) setPreference(parseThemePreference(raw)); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [storage]);

  const onChange = useCallback((p: ThemePreference) => {
    setPreference(p);
    storage.setString(THEME_PREFERENCE_KEY, p).catch(() => undefined);
  }, [storage]);

  return (
    <ThemeProvider preference={preference} onPreferenceChange={onChange} isRTL={isRtl(resolveLocale(i18n.language))} fontsLoaded={props.fontsLoaded} labels={labels}>
      {props.children}
    </ThemeProvider>
  );
}
