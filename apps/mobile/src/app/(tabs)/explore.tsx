import { StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { spacing, typography } from "@outlet/ui-tokens";
import { useColors } from "../../theme";

export default function Screen() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      <Text style={[styles.title, { color: c.textPrimary }]}>{t("tabs.explore")}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg },
  title: { ...typography.title },
});
