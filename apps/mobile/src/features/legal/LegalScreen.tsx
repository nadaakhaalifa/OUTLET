import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Eyebrow, Reveal, Screen, Text } from "../../ui";
import type { Block } from "./markdown";
import { legalDocView, type LegalDocId, type LegalLocale } from "./model";

export function Blk(props: { b: Block }) {
  const { b } = props;
  const label = b.spans.map((s) => s.text).join("");
  if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") {
    return <Text variant={b.kind === "h1" ? "display" : b.kind === "h2" ? "title2" : "headline"} accessibilityRole="header" style={{ marginTop: b.kind === "h1" ? 0 : 12 }}>{label}</Text>;
  }
  if (b.kind === "quote") return <Banner tone="warning" message={label} />;
  if (b.kind === "li") {
    return (
      <View style={{ flexDirection: "row", gap: 10 }} accessible accessibilityLabel={label}>
        <Text accessibilityRole="none">{"•"}</Text>
        <Text style={{ flex: 1 }} accessibilityRole="none">{label}</Text>
      </View>
    );
  }
  return <Text variant={b.kind === "row" ? "callout" : "body"} secondary={b.kind === "row"} >{label}</Text>;
}

/** Renders a bundled legal draft. Every document is shown with a "Draft for counsel review" notice. */
export function LegalScreen(props: { id: LegalDocId }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: LegalLocale = i18n.language === "en" ? "en" : "ar";
  const view = legalDocView(props.id, locale);
  return (
    <Screen onBack={() => router.back()} backLabel={t("common.back")}>
      <Eyebrow color="danger" secondary={false}>{t("legal.draftBadge")}</Eyebrow>
      <Banner tone="warning" message={t("legal.draftNotice")} />
      {view.blocks.map((b, i) => (i < 8 ? <Reveal key={i} index={i}><Blk b={b} /></Reveal> : <Blk key={i} b={b} />))}
    </Screen>
  );
}
