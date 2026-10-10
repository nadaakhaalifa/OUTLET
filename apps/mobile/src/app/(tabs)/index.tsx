import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { radius, spacing, typography } from "@outlet/ui-tokens";
import { useColors } from "../../theme";

export default function HomeScreen() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      <Text style={[styles.title, { color: c.textPrimary }]}>{t("home.title")}</Text>
      {__DEV__ ? (
        <View style={[styles.notice, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.noticeText, { color: c.textSecondary }]}>
            {t("home.devFixtureNotice")}
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  title: { ...typography.title },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  noticeText: { ...typography.caption },
});
