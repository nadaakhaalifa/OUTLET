import { memo, useState } from "react";
import { View } from "react-native";
import { brand, radius, shadows } from "@outlet/ui-tokens";
import { Icon, PressScale, Text, useTheme, type IconName } from "../../ui";
import { useFormat } from "../home/parts";
import { homeReasonKey } from "../home/model";

function Action(props: { icon: IconName; title: string; hint: string; onPress: () => void; testID: string; tone: "ink" | "sand" }) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const bg = props.tone === "ink" ? colors.accent : pressed ? colors.storesTilePressed : colors.storesTile;
  const fg = props.tone === "ink" ? "onAccent" : "onSand";
  const fgHex = props.tone === "ink" ? colors.onAccent : colors.onSand;
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={`${props.title}, ${props.hint}`} testID={props.testID} scale={0.98} onPressedChange={setPressed} style={{ flex: 1 }}>
      <View style={{ minHeight: 88, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.lg, backgroundColor: bg, ...shadows.lift, borderWidth: props.tone === "sand" ? 2 : 0, borderColor: colors.sand }}>
        <View pointerEvents="none" style={{ position: "absolute", top: 0, start: 12, end: 12, height: 1, backgroundColor: brand.ivory + "1F" }} />
        <View style={{ width: 32, height: 32, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: fgHex + "55" }}>
          <Icon name={props.icon} size={18} color={fg} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="callout" weight="600" color={fg} accessibilityRole="none">{props.title}</Text>
          <Text variant="caption" color={fg} accessibilityRole="none" style={{ opacity: 0.9 }}>{props.hint}</Text>
        </View>
      </View>
    </PressScale>
  );
}

/** Two bold filled actions under the hero: shop the whole catalogue, or browse stores. */
export const QuickActions = memo(function QuickActions(props: { onViewStores: () => void; onShopEverything: () => void; area?: string | null | undefined }) {
  const { t } = useFormat();
  const stores = homeReasonKey("stores", props.area ?? null);
  const all = homeReasonKey("all_pieces", null);
  return (
    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 12, paddingHorizontal: 16 }} testID="home-quick-actions">
      <Action icon="bag-handle-outline" title={t("homeBanners.shopEverything")} hint={t(all.key, all.vars)} onPress={props.onShopEverything} testID="home-shop-everything" tone="ink" />
      <Action icon="location-outline" title={t("homeBanners.viewStores")} hint={t(stores.key, stores.vars)} onPress={props.onViewStores} testID="home-view-stores" tone="sand" />
    </View>
  );
});
