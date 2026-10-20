/** Branded cover shown while a language change applies and the app reloads, so no half-applied state is visible. */
import { useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { DEEP, Wordmark } from "../art";
import { Text, useTheme } from "../ui";
import { languageApplying } from "../i18n";

export function LanguageApplyingOverlay() {
  const busy = useSyncExternalStore(languageApplying.subscribe, languageApplying.get, languageApplying.get);
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!busy) return null;
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={t("language.applying")} style={[StyleSheet.absoluteFill, { backgroundColor: DEEP, alignItems: "center", justifyContent: "center", gap: 20, zIndex: 1000 }]}>
      <Wordmark tone="dark" size={34} />
      <ActivityIndicator color={colors.onImage} />
      <Text variant="callout" color="onImage" align="center">{t("language.applying")}</Text>
    </View>
  );
}
