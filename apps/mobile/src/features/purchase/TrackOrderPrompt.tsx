import { useEffect, useState } from "react";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { useTranslation } from "react-i18next";
import { Button, Card, Text } from "../../ui";
import { useServices } from "../../state/services";
import { NOTIF_PROMPT_KEY, askOnce, unconfiguredNotificationPermission, type NotificationPermissionPort } from "./notification-prompt";

/**
 * Rendered by the order-success screen once an order is placed. Shows only when a push adapter exists and the person has
 * not been asked before. "Not now" records the answer and never asks again.
 */
export function TrackOrderPrompt(props: { port?: NotificationPermissionPort }) {
  const { t } = useTranslation();
  const services = useServices();
  const port = props.port ?? unconfiguredNotificationPermission;
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    void services.storage.getString(NOTIF_PROMPT_KEY).then((v) => { if (alive) setShow(v === null && port !== unconfiguredNotificationPermission); }, () => undefined);
    return () => { alive = false; };
  }, [services, port]);
  if (!show) return null;
  const deps = { port, read: () => services.storage.getString(NOTIF_PROMPT_KEY), write: (v: string) => services.storage.setString(NOTIF_PROMPT_KEY, v) };
  return (
    <Card variant="elevated" style={{ gap: spacing.sm }}>
      <Text variant="headline" weight="600">{t("guestMe.notifTitle")}</Text>
      <Text variant="callout" secondary>{t("guestMe.notifBody")}</Text>
      <View style={{ gap: spacing.sm }}>
        <Button title={t("guestMe.notifAllow")} onPress={() => { setShow(false); void askOnce(deps, true); }} />
        <Button variant="ghost" title={t("guestMe.notifLater")} onPress={() => { setShow(false); void deps.write("1"); }} />
      </View>
    </Card>
  );
}
