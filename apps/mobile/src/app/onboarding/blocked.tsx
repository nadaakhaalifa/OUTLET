import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Divider, Reveal, Screen, Text, useTheme } from "../../ui";
import { Wordmark } from "../../art";
import { formatBlockedUntil } from "../../features/age-gate";
import { useServices } from "../../state/services";

/** Polite, final under-18 screen. No retry control and no mention of the entered date. */
export default function BlockedStep() {
  const { t, i18n } = useTranslation();
  const services = useServices();
  const { isDark } = useTheme();
  const [deviceBlocked, setDeviceBlocked] = useState(false);
  const [until, setUntil] = useState<string | null>(null);

  useEffect(() => {
    void services.isThisDeviceBlocked().then(setDeviceBlocked, () => setDeviceBlocked(false));
    void services.loadSoftBlock().then(
      (b) => setUntil(b === null ? null : b.blockedUntil),
      () => setUntil(null),
    );
  }, [services]);
  const date = until === null ? "" : formatBlockedUntil(until, i18n.language === "en" ? "en" : "ar");

  return (
    <Screen>
      <View style={{ gap: spacing.xl, paddingTop: spacing.xl }}>
        <Reveal index={0}><Wordmark size={16} tone={isDark ? "dark" : "light"} /></Reveal>
        <Reveal index={1}><Text variant="display" accessibilityRole="header">{t("age.blocked.title")}</Text></Reveal>
        <Reveal index={2}><Divider /></Reveal>
        <Reveal index={3}>
          <View style={{ gap: spacing.md }}>
            <Text variant="lede">{t("age.blocked.body")}</Text>
            {date !== "" ? <Text>{t("age.blocked.until", { date })}</Text> : null}
            <Text secondary>{t("age.blocked.later")}</Text>
          </View>
        </Reveal>
        {deviceBlocked ? <Reveal index={4}><Text variant="caption" secondary>{t("age.blocked.deviceBlockedBody")}</Text></Reveal> : null}
      </View>
    </Screen>
  );
}
