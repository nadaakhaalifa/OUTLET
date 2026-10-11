import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Card, Screen, Text } from "../../ui";
import { formatBlockedUntil } from "../../features/age-gate";
import { useServices } from "../../state/services";

/** Polite, final under-18 screen. No retry control and no mention of the entered date. */
export default function BlockedStep() {
  const { t, i18n } = useTranslation();
  const services = useServices();
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
      <View style={{ gap: spacing.lg }}>
        <Text variant="title">{t("age.blocked.title")}</Text>
        <Card>
          <Text>{t("age.blocked.body")}</Text>
          {date !== "" ? <Text>{t("age.blocked.until", { date })}</Text> : null}
          <Text secondary>{t("age.blocked.later")}</Text>
        </Card>
        {deviceBlocked ? <Text secondary>{t("age.blocked.deviceBlockedBody")}</Text> : null}
      </View>
    </Screen>
  );
}
