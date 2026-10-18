import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button, useTheme } from "../../ui";
import { applyLanguage } from "../../i18n";
import { useServices } from "../../state/services";
import { LOCALE_NATIVE_NAME, otherLocale } from "./model";
import { ThemeSegments } from "./ThemeSegments";

/**
 * Language switch (shows the OTHER language) plus a light/dark/system button.
 * Placement: put it at the top END of the screen. The row uses flex-start/flex-end logic, never left/right, so in the
 * English (LTR) layout it sits top right and in RTL it mirrors to top left. Targets are the kit's 44pt minimum.
 * Reuses the existing preference mechanisms: applyLanguage (persisted, RTL reload flow) and useTheme().setPreference.
 */
export function LanguageThemeToggle(props: { testIDPrefix?: string }) {
  const { t, i18n } = useTranslation();
  const services = useServices();
  const theme = useTheme();
  const prefix = props.testIDPrefix ?? "chrome";
  const target = otherLocale(i18n.language);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: theme.spacing.xs }}>
      <Button
        title={LOCALE_NATIVE_NAME[target]}
        variant="ghost"
        onPress={() => void applyLanguage(target, services.storage)}
        accessibilityLabel={t("chrome.languageA11y", { language: LOCALE_NATIVE_NAME[target] })}
        testID={`${prefix}-language`}
      />
      <ThemeSegments testIDPrefix={prefix} />
    </View>
  );
}
