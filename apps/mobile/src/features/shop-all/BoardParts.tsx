/* eslint-disable @typescript-eslint/no-require-imports -- dev-fixture photography only, behind __DEV__ */
import type { ReactNode } from "react";
import { Pressable, View, type ImageSourcePropType } from "react-native";
import { radius } from "@outlet/ui-tokens";
import { Icon, PressScale, StoreName, Text, useTheme } from "../../ui";

/** Dev-fixture photography only (cropped from the design board). Production builds get null and fall back to the art slots. */
export const DEV_GRID: readonly ImageSourcePropType[] | null = __DEV__ ? [
  require("../../../assets/dev-fixtures/board/shop-grid-1.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/shop-grid-2.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/shop-grid-3.png") as ImageSourcePropType,
  require("../../../assets/dev-fixtures/board/shop-grid-4.png") as ImageSourcePropType,
] : null;
export const DEV_HERO: ImageSourcePropType | null = __DEV__ ? require("../../../assets/dev-fixtures/board/category-hero.png") as ImageSourcePropType : null;

/** Board product card (screens 2 and 4): image with dark discount pill and heart, store name (bold, never uppercased), name, price and strike. */
export function BoardCard(props: {
  image: ReactNode; pillText: string | null; brand: string; name: string; priceText: string; referenceText: string | null;
  saved: boolean; onToggleSave: () => void; saveLabel: string; onPress: () => void; accessibilityLabel: string; testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel} scale={0.99} style={{ flex: 1 }} testID={props.testID}>
      <View style={{ gap: 8, paddingBottom: 12 }}>
        <View style={{ aspectRatio: 1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.fill }}>
          {props.image}
          {props.pillText !== null ? (
            <View style={{ position: "absolute", top: 6, start: 6, backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2 }}>
              <Text variant="caption" weight="600" style={{ color: colors.background }} accessibilityRole="none">{props.pillText}</Text>
            </View>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={props.saveLabel} accessibilityState={{ selected: props.saved }} hitSlop={12} onPress={props.onToggleSave}
            style={{ position: "absolute", top: 6, end: 6, width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
            <Icon name={props.saved ? "heart" : "heart-outline"} size={16} color={props.saved ? "danger" : "textSecondary"} />
          </Pressable>
        </View>
        <View style={{ gap: 2, paddingHorizontal: 2 }}>
          {props.brand.length > 0 ? <StoreName name={props.brand} layout="tile" /> : null}
          <Text variant="caption" secondary numberOfLines={1}>{props.name}</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
            <Text variant="callout" weight="600" accessibilityRole="none">{props.priceText}</Text>
            {props.referenceText !== null ? (
              <Text variant="caption" secondary style={{ textDecorationLine: "line-through" }} accessibilityRole="none">{props.referenceText}</Text>
            ) : null}
          </View>
        </View>
      </View>
    </PressScale>
  );
}
