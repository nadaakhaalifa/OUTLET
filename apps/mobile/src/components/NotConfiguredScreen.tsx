/** Blocking state for a release build without a usable backend URL: no fixture data is ever shown instead. */
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text, useTheme } from "../ui";

export function NotConfiguredScreen() {
  const { t } = useTranslation();
  const { colors, spacing } = useTheme();
  return (
    <View accessibilityRole="alert" style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md }}>
      <Text variant="headline">{t("common.notConfiguredTitle")}</Text>
      <Text secondary>{t("common.notConfiguredBody")}</Text>
    </View>
  );
}
