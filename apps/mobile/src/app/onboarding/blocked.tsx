import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Card, Screen, Text } from "../../ui";
import { useServices } from "../../state/services";

/** Polite, final under-18 screen. No retry control and no mention of the entered date. */
export default function BlockedStep() {
  const { t } = useTranslation();
  const services = useServices();
  const [deviceBlocked, setDeviceBlocked] = useState(false);

  useEffect(() => {
    void services.isThisDeviceBlocked().then(setDeviceBlocked, () => setDeviceBlocked(false));
  }, [services]);

  return (
    <Screen>
      <View style={{ gap: spacing.lg }}>
        <Text variant="title">{t("age.blocked.title")}</Text>
        <Card>
          <Text>{t("age.blocked.body")}</Text>
          <Text secondary>{t("age.blocked.later")}</Text>
        </Card>
        {deviceBlocked ? <Text secondary>{t("age.blocked.deviceBlockedBody")}</Text> : null}
      </View>
    </Screen>
  );
}
