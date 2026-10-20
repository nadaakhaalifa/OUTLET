import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { radius, spacing } from "@outlet/ui-tokens";
import { Icon, PressScale, StoreName, Text, useTheme } from "../../ui";
import { cardDetailLevel, detailDensityForWidth, type Density } from "./model";

export interface DensityCardHeart {
  saved: boolean;
  onToggle: () => void;
  /** Already-localized label, e.g. "Save item". */
  accessibilityLabel: string;
}

export interface DensityProductCardProps {
  /** Preference; used as is on compact windows (iPhone). */
  density: Density;
  /** Rendered card width in points. On regular and expanded windows the detail level comes from this (effective) width, not the density. */
  cardWidth?: number | undefined;
  /** Pre-built image (3:4 area is provided here). Request width via imageWidthRequest. */
  imageNode: ReactNode;
  storeLabel?: string | undefined;
  name: string;
  /** Pre-formatted price (kit price component); never computed here. */
  priceNode: ReactNode;
  heart?: DensityCardHeart | undefined;
  onPress: () => void;
  accessibilityLabel?: string | undefined;
  testID?: string | undefined;
}

/** Presentational card: fields in, density-appropriate layout out. Logical start/end only, so RTL mirrors. */
export function DensityProductCard(props: DensityProductCardProps) {
  const { colors, layout } = useTheme();
  const density: Density = layout.sizeClass !== "compact" && props.cardWidth !== undefined ? detailDensityForWidth(props.cardWidth / layout.z) : props.density;
  const level = cardDetailLevel(density);
  const heart = props.heart;
  const showHeart = heart !== undefined && (level.heart === "full" || level.heart === "small");
  const imgRadius = density >= 3 ? radius.sm : radius.lg;
  return (
    <PressScale
      testID={props.testID}
      onPress={props.onPress}
      onLongPress={level.heart === "longPress" && heart !== undefined ? heart.onToggle : undefined}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.name}
      scale={0.99}
      style={{ flex: 1 }}
    >
      <View style={{ gap: density === 4 ? spacing.xs : spacing.sm }}>
        <View style={{ aspectRatio: 3 / 4, borderRadius: imgRadius, overflow: "hidden", backgroundColor: colors.fill }}>
          {props.imageNode}
          {showHeart ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={heart.accessibilityLabel}
              accessibilityState={{ selected: heart.saved }}
              hitSlop={level.heartHitSlop}
              onPress={heart.onToggle}
              style={{
                position: "absolute", top: spacing.xs, end: spacing.xs,
                width: level.heartSize, height: level.heartSize, borderRadius: radius.pill,
                alignItems: "center", justifyContent: "center", backgroundColor: colors.glassSolid,
              }}
            >
              <Icon name={heart.saved ? "heart" : "heart-outline"} size={level.heartSize <= 24 ? 14 : 18} color={heart.saved ? "danger" : "textPrimary"} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ gap: 2 }}>
          {level.showStore && props.storeLabel !== undefined ? (
            <StoreName name={props.storeLabel} layout="tile" />
          ) : null}
          {level.showName ? (
            <Text variant={density === 3 ? "caption" : "callout"} numberOfLines={level.nameLines}>{props.name}</Text>
          ) : null}
          {level.showPrice ? props.priceNode : null}
        </View>
      </View>
    </PressScale>
  );
}
