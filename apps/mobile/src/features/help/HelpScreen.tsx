import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Illustration } from "../../art";
import { Divider, Eyebrow, ListRow, Reveal, Screen, Text } from "../../ui";
import { FAQ_IDS, toggleFaq, type FaqId } from "./model";

export function HelpScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState<FaqId | null>(null);
  return (
    <Screen title={t("help.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Reveal index={0}><Text variant="lede" secondary>{t("help.body")}</Text></Reveal>
      <Reveal index={1}><View style={{ alignItems: "center" }}><Illustration name="deliveryTruck" size={96} /></View></Reveal>
      <Reveal index={2}><View>
        <Eyebrow>{t("help.faqHeading")}</Eyebrow>
        <View style={{ height: 8 }} />
        <Divider />
        {FAQ_IDS.map((id) => (
          <View key={id}>
            <ListRow title={t(`help.faq.${id}.q`)} chevron={false} trailing={<Text secondary accessibilityRole="none">{open === id ? "–" : "+"}</Text>} onPress={() => setOpen(toggleFaq(open, id))} />
            {open === id ? <Text secondary style={{ paddingBottom: 14 }}>{t(`help.faq.${id}.a`)}</Text> : null}
            <Divider />
          </View>
        ))}
      </View></Reveal>
      <Reveal index={3}><View>
        <Eyebrow>{t("help.contactHeading")}</Eyebrow>
        <Text secondary style={{ marginTop: 8 }}>{t("help.contactBody")}</Text>
        <View style={{ height: 8 }} />
        <Divider />
        <ListRow title={t("help.orders")} divider onPress={() => router.push("/orders")} />
      </View></Reveal>
    </Screen>
  );
}
