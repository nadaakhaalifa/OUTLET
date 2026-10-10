import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ListRow, Screen, Text } from "../../ui";

export default function MeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Screen>
      <Text variant="title">{t("tabs.me")}</Text>
      <ListRow title={t("privacy.title")} onPress={() => router.push("/privacy-center")} />
    </Screen>
  );
}
