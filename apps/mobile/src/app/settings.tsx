import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, Screen, Text } from "../ui";

export default function SettingsRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Screen>
      <Text variant="title">{t("settings.title")}</Text>
      <Text secondary>{t("settings.body")}</Text>
      <Button variant="secondary" title={t("settings.openPrivacy")} onPress={() => router.push("/privacy-center")} />
    </Screen>
  );
}
