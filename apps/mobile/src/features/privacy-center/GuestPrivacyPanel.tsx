import { useState } from "react";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Button, Divider, Eyebrow, Screen, SwitchRow, Text } from "../../ui";
import { getGuestStore } from "../../state/ports";
import { useServices } from "../../state/services";
import { clearLocalData } from "./guest";

/** What a signed-out shopper sees instead of the server Privacy Center. Honest, local-only, no account prompt. */
export function GuestPrivacyPanel() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [analytics, setAnalytics] = useState(() => services.consent.view().analytics);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<"cleared" | "failed" | null>(null);
  const toggle = (v: boolean) => { setAnalytics(v); void services.consent.set("analytics", v, "settings_toggle").catch(() => setAnalytics(!v)); };
  const clear = async () => { setConfirm(false); setNotice(await clearLocalData(getGuestStore(), services.storage)); };
  return (
    <Screen title={t("guestMe.dataTitle")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Text variant="lede" secondary>{t("guestMe.dataStored")}</Text>
      <Text variant="caption" secondary>{t("guestMe.dataSize")}</Text>
      <View>
        <Eyebrow>{t("guestMe.analyticsLabel")}</Eyebrow>
        <SwitchRow label={t("guestMe.analyticsLabel")} value={analytics} onValueChange={toggle} />
        <Text variant="caption" secondary>{t("guestMe.analyticsNote")}</Text>
      </View>
      <Divider />
      {notice !== null ? <Banner tone={notice === "cleared" ? "info" : "error"} message={t(notice === "cleared" ? "guestMe.cleared" : "guestMe.clearFailed")} /> : null}
      {confirm ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="callout">{t("guestMe.clearBody")}</Text>
          <Button variant="secondary" title={t("guestMe.clearConfirm")} onPress={() => void clear()} />
          <Button variant="ghost" title={t("common.cancel")} onPress={() => setConfirm(false)} />
        </View>
      ) : <Button variant="secondary" title={t("guestMe.clearAction")} onPress={() => setConfirm(true)} />}
    </Screen>
  );
}
