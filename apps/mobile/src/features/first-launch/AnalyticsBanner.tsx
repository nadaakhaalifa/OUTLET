import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Button, GlassSurface, Text } from "../../ui";
import { useServices } from "../../state/services";
import { answerAnalyticsBanner, shouldShowAnalyticsBanner, type BannerChoice } from "./model";

/**
 * Non-blocking consent banner for anonymous usage stats (ADR-0055 section 5). Device-stored consent; no analytics SDK
 * starts before "Allow". Equal-weight choices, nothing pre-selected, no account mention. Mounted by Home.
 */
export function AnalyticsBanner() {
  const { t } = useTranslation();
  const services = useServices();
  const [visible, setVisible] = useState(() => shouldShowAnalyticsBanner(services.consent.history()));

  useEffect(() => {
    setVisible(shouldShowAnalyticsBanner(services.consent.history()));
    return services.consent.subscribe(() => setVisible(shouldShowAnalyticsBanner(services.consent.history())));
  }, [services]);

  if (!visible) return null;
  const answer = (choice: BannerChoice) => {
    setVisible(false);
    answerAnalyticsBanner(services.consent, choice).catch(() => undefined); // in memory first; a sync failure retries later
  };
  return (
    <GlassSurface innerStyle={{ padding: spacing.md, gap: spacing.sm }} testID="analytics-banner">
      <Text variant="callout" weight="600">{t("firstLaunch.analyticsTitle")}</Text>
      <Text variant="caption" secondary>{t("firstLaunch.analyticsBody")}</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}><Button variant="secondary" fullWidth title={t("firstLaunch.allow")} onPress={() => answer("allow")} testID="analytics-allow" /></View>
        <View style={{ flex: 1 }}><Button variant="secondary" fullWidth title={t("firstLaunch.notNow")} onPress={() => answer("not_now")} testID="analytics-not-now" /></View>
      </View>
    </GlassSurface>
  );
}
