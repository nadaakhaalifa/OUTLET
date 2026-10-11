import { useTranslation } from "react-i18next";
import { Screen, Text } from "../ui";

export default function HelpRoute() {
  const { t } = useTranslation();
  return (
    <Screen>
      <Text variant="title">{t("help.title")}</Text>
      <Text secondary>{t("help.body")}</Text>
    </Screen>
  );
}
