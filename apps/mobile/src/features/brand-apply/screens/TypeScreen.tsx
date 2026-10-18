import { useEffect } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Card, Eyebrow, Icon, PressScale, Reveal, Screen, Text, useTheme } from "../../../ui";
import { HeroArt, Wordmark } from "../../../art";
import { useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { defaultCountry } from "../countries";
import type { BrandKind } from "../model";

/** First impression for a brand: ivory page, inset rounded art, Playfair title and two raised choice cards. */
export function TypeScreen() {
  const { t } = useTranslation();
  const { colors, spacing, radii } = useTheme();
  const s = useBrandApply();
  const nav = useFlowNav();
  useEffect(() => { s.rememberStep("type"); }, [s.rememberStep]);

  const choose = (kind: BrandKind) => {
    const keep = s.draft.kind === kind;
    s.patchDraft({ kind, country: keep ? s.draft.country : defaultCountry(kind), step: "country" });
    nav.to("country");
  };
  const card = (index: number, kind: BrandKind, icon: "home-outline" | "earth-outline", title: string, body: string) => (
    <Reveal index={index + 2}>
      <Card variant="elevated" style={{ paddingVertical: 0, paddingHorizontal: 0 }}>
        <PressScale
          onPress={() => choose(kind)} testID={`brand-type-${kind}`} accessibilityRole="button" accessibilityLabel={`${title}. ${body}`}
          innerStyle={{ padding: spacing.lg, minHeight: 96, flexDirection: "row", alignItems: "center", gap: spacing.lg }}
        >
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.sand, alignItems: "center", justifyContent: "center" }}>
            <Icon name={icon} size={24} color="onSand" />
          </View>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="headline">{title}</Text>
            <Text variant="callout" secondary>{body}</Text>
          </View>
          <Icon name="chevron-forward" directional size={20} color="textSecondary" />
        </PressScale>
      </Card>
    </Reveal>
  );

  return (
    <Screen onBack={nav.back} backLabel={t("brandApply.common.back")}>
      <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
        <Reveal>
          <View style={{ borderRadius: radii.xl - 4, overflow: "hidden" }}>
            <HeroArt variant="drop" aspect={1.7} />
          </View>
        </Reveal>
        <Reveal index={1}>
          <View style={{ gap: spacing.md }}>
            <Wordmark size={18} />
            <Eyebrow secondary>{t("brandApply.type.eyebrow")}</Eyebrow>
            <Text variant="display" accessibilityRole="header">{t("brandApply.type.title")}</Text>
            <Text variant="lede" secondary>{t("brandApply.type.subtitle")}</Text>
          </View>
        </Reveal>
        <View style={{ gap: spacing.md }}>
          {card(0, "local", "home-outline", t("brandApply.type.local.title"), t("brandApply.type.local.body"))}
          {card(1, "global", "earth-outline", t("brandApply.type.global.title"), t("brandApply.type.global.body"))}
          <Text variant="caption" secondary align="center">{t("brandApply.type.footnote")}</Text>
        </View>
      </View>
    </Screen>
  );
}
