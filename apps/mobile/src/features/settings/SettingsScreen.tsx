import { useEffect, useState } from "react";
import { View } from "react-native";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { applyLanguage } from "../../i18n";
import { getFeaturePorts } from "../../state/ports";
import { useServices } from "../../state/services";
import { Banner, Divider, Eyebrow, ListRow, Reveal, Screen, SegmentedControl, SwitchRow, Text, useTheme } from "../../ui";
import { SELL_ROUTE } from "../me/routes";
import { useGuestGateMode } from "../me/useGuest";
import { SETTINGS_LEGAL_LINKS } from "../legal/model";
import { LANGUAGES, NOTIFICATION_PURPOSES, THEMES, languageAt, languageIndex, notificationState, themeAt, themeIndex, type NotificationPurpose } from "./model";

export function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const theme = useTheme();
  const [notif, setNotif] = useState<Readonly<Record<NotificationPurpose, boolean>> | null>(null);
  const [failed, setFailed] = useState(false);
  const guest = useGuestGateMode() !== "member";
  const version = Constants.expoConfig?.version ?? "0.0.0";

  useEffect(() => {
    // Notification choices are account consents: a guest (or an unknown state) fetches nothing.
    if (guest) return undefined;
    let alive = true;
    getFeaturePorts().privacy.load().then((s) => { if (alive) setNotif(notificationState(s.consents)); }, () => { if (alive) setNotif(null); });
    return () => { alive = false; };
  }, [guest]);

  const setLanguage = async (i: number) => {
    const lang = languageAt(i);
    await applyLanguage(lang, services.storage);
  };
  const toggle = async (p: NotificationPurpose, v: boolean) => {
    setNotif((n) => (n === null ? n : { ...n, [p]: v }));
    setFailed(false);
    try { await getFeaturePorts().privacy.setConsent(p, v); } catch { setFailed(true); }
  };

  return (
    <Screen title={t("settings.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Reveal index={0}><View style={{ gap: 10 }}>
        <Eyebrow>{t("settings.languageHeading")}</Eyebrow>
        <SegmentedControl options={LANGUAGES.map((l) => t(l === "ar" ? "language.arabic" : "language.english"))} index={languageIndex(i18n.language)} onChange={(i) => void setLanguage(i)} />
      </View></Reveal>
      <Reveal index={1}><View style={{ gap: 10 }}>
        <Eyebrow>{t("settings.themeHeading")}</Eyebrow>
        <SegmentedControl options={THEMES.map((p) => t(`settings.theme.${p}`))} index={themeIndex(theme.preference)} onChange={(i) => theme.setPreference(themeAt(i))} />
      </View></Reveal>
      {guest ? null : <Reveal index={2}><View>
        <Eyebrow>{t("settings.notificationsHeading")}</Eyebrow>
        <Text variant="caption" secondary style={{ marginTop: 6 }}>{t("settings.notificationsNote")}</Text>
        {notif !== null ? NOTIFICATION_PURPOSES.map((p) => (
          <SwitchRow key={p} label={t(`settings.notif.${p}`)} value={notif[p]} onValueChange={(v) => void toggle(p, v)} />
        )) : null}
        {failed ? <Banner tone="error" message={t("settings.notifFailed")} /> : null}
      </View></Reveal>}
      <Reveal index={3}><View>
        <Eyebrow>{t("settings.privacyHeading")}</Eyebrow>
        <Divider />
        {/* Device-local region and shopping preference; opens the first-run screen in edit mode. */}
        <ListRow title={t("settings.regionRow")} divider onPress={() => router.push({ pathname: "/welcome-region", params: { mode: "edit" } })} />
        <ListRow title={guest ? t("guestMe.dataRow") : t("settings.openPrivacy")} divider onPress={() => router.push("/privacy-center")} />
        {/* Quiet brand path (spec F1c): a row, never a banner. */}
        <ListRow title={t("guestMe.sellRow")} divider onPress={() => router.push(SELL_ROUTE)} />
      </View></Reveal>
      <Reveal index={4}><View>
        <Eyebrow>{t("settings.legalHeading")}</Eyebrow>
        <Text variant="caption" secondary style={{ marginTop: 6, marginBottom: 6 }}>{t("legal.draftNotice")}</Text>
        <Divider />
        {SETTINGS_LEGAL_LINKS.map((id) => (
          <ListRow key={id} title={t(`legal.doc.${id}`)} divider onPress={() => router.push({ pathname: "/legal/[id]", params: { id } })} />
        ))}
      </View></Reveal>
      <Text variant="caption" secondary align="center">{t("settings.version", { version })}</Text>
    </Screen>
  );
}
