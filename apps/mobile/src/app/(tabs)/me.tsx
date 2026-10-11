import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { TestId } from "../../components/TestId";
import type { GiftCapabilities } from "../../features/gift-cards/model";
import { visibleMeRows } from "../../features/navigation/model";
import { getFeaturePorts } from "../../state/ports";
import { ListRow, Screen, Text } from "../../ui";

export default function MeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  // Unknown until loaded: the gift-cards row stays hidden while the kill-switch state is unknown.
  const [gift, setGift] = useState<GiftCapabilities | null>(null);

  useEffect(() => {
    let alive = true;
    getFeaturePorts().giftCards.load().then(
      (s) => { if (alive) setGift(s.capabilities); },
      () => { if (alive) setGift(null); },
    );
    return () => { alive = false; };
  }, []);

  const rows = visibleMeRows(gift);
  return (
    <Screen>
      <Text variant="title">{t("me.title")}</Text>
      <View accessibilityRole="list" accessibilityLabel={t("me.menuLabel")}>
        {rows.map((r) => (
          <TestId key={r.id} id={r.testID}>
            <ListRow
              title={t(r.titleKey)}
              {...(r.hintKey !== undefined ? { accessibilityHint: t(r.hintKey) } : {})}
              onPress={() => router.push(r.href)}
            />
          </TestId>
        ))}
      </View>
    </Screen>
  );
}
