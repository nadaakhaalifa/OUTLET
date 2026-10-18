import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { useTheme } from "../theme";
import { badgeView, initials, ratingView, type BadgeKind } from "../logic/misc";
import { toneColors, type Tone } from "../logic/palette";
import { priceView, type VerifiedClaim } from "../logic/price";
import { joinLabel } from "../logic/a11y";
import { showVerifiedGlyph, storeNameLines, type StoreNameLayout } from "../logic/brand";
import { Eyebrow, Icon, PressScale, Text, type IconName } from "./primitives";
import { IconButton } from "./glass";

/**
 * Store or brand name: `brandName` role (semibold, textPrimary, never uppercase). One line with tail ellipsis on tiles,
 * two lines on rows. The verified glyph shows only when `verified` is true.
 */
export function StoreName(props: { name: string; verified?: boolean | null | undefined; layout?: StoreNameLayout | undefined; verifiedLabel?: string | undefined; testID?: string | undefined }) {
  const { s, sc } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: s(4) }} testID={props.testID}>
      <View style={{ flexShrink: 1 }}>
        <Text variant="brandName" numberOfLines={storeNameLines(props.layout ?? "tile")} accessibilityRole="none">{props.name}</Text>
      </View>
      {showVerifiedGlyph(props.verified) ? <View accessible accessibilityLabel={props.verifiedLabel}><Icon name="checkmark-circle" size={sc(14)} color="savings" /></View> : null}
    </View>
  );
}

/** Quiet status label. Pass `kind` for the named variants, or legacy `tone`. */
export function Badge(props: { label: string; kind?: BadgeKind | undefined; tone?: Tone | undefined }) {
  const { colors, scheme, s, sc, radii, sized } = useTheme();
  const legacy = props.tone !== undefined && props.kind === undefined ? toneColors(props.tone, scheme) : null;
  const v = badgeView(props.kind ?? "neutral");
  const fg = legacy ? legacy.foreground : colors[v.fg];
  const bg = legacy ? legacy.background : v.bg ? colors[v.bg] : "transparent";
  const border = legacy ? legacy.border : v.border ? colors[v.border] : "transparent";
  return (
    <View accessible accessibilityLabel={props.label} style={{ alignSelf: "flex-start", minHeight: s(20), paddingHorizontal: s(7), flexDirection: "row", alignItems: "center", gap: s(4), borderRadius: radii.pill, backgroundColor: bg, borderWidth: StyleSheet.hairlineWidth, borderColor: border }}>
      {v.dot ? <View style={{ width: s(6), height: s(6), borderRadius: s(3), backgroundColor: colors[v.dot] }} /> : null}
      {v.icon ? <Icon name={v.icon as IconName} size={sc(12)} color={v.fg} /> : null}
      <Text variant="caption" weight="500" style={{ color: fg, ...sized(10.5, 14) }} accessibilityRole="none">{props.label}</Text>
    </View>
  );
}

export interface PriceClaimProps extends VerifiedClaim {
  /** Preformatted reference price (money-display) and percent text, e.g. "-25%". */
  readonly referenceText: string;
  readonly percentText: string;
}

/**
 * Current price large and tabular. A strike-through reference and percent appear ONLY for a verified,
 * arithmetically consistent claim (spec §9); otherwise plain price, or the "Launch price" label.
 */
export function PriceBlock(props: { priceText: string; priceMinor: bigint; claim?: PriceClaimProps | undefined; launch?: boolean | undefined; launchLabel?: string | undefined; size?: "md" | "lg" | undefined; verifiedLabel?: string | undefined }) {
  const { s } = useTheme();
  const view = priceView(props.priceMinor, props.claim, props.launch === true);
  const claim = view.kind === "claim" ? props.claim : undefined;
  const lg = props.size === "lg";
  return (
    <View accessible accessibilityLabel={joinLabel(props.priceText, claim ? props.verifiedLabel : undefined, claim ? claim.percentText : undefined, view.kind === "launch" ? props.launchLabel : undefined)} style={{ gap: s(2) }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: s(6), flexWrap: "wrap" }}>
        <Text variant={lg ? "title2" : "callout"} weight="600" numeric accessibilityRole="none">{props.priceText}</Text>
        {claim ? <Text variant="caption" secondary numeric style={{ textDecorationLine: "line-through" }} accessibilityRole="none">{claim.referenceText}</Text> : null}
        {claim ? <Text variant="caption" color="savings" weight="500" numeric accessibilityRole="none">{claim.percentText}</Text> : null}
      </View>
      {view.kind === "launch" && props.launchLabel ? <Eyebrow>{props.launchLabel}</Eyebrow> : null}
    </View>
  );
}

export interface ImageSlotProps {
  /** Remote or local image. Ignored when `imageNode` is given. */
  readonly imageUri?: string | undefined;
  readonly blurhash?: string | undefined;
  /** Art-kit placeholder or any node. */
  readonly imageNode?: ReactNode;
}

export function ImageSlot(props: ImageSlotProps & { style?: StyleProp<ViewStyle> | undefined; aspectRatio?: number | undefined; label?: string | undefined; cornerRadius?: number | undefined }) {
  const { colors, radii } = useTheme();
  return (
    <View accessible={props.label !== undefined} accessibilityRole={props.label !== undefined ? "image" : undefined} accessibilityLabel={props.label} style={[{ aspectRatio: props.aspectRatio ?? 3 / 4, backgroundColor: colors.fill, overflow: "hidden", borderRadius: props.cornerRadius ?? radii.lg }, props.style]}>
      {props.imageNode !== undefined ? props.imageNode
        : props.imageUri !== undefined ? <Image source={{ uri: props.imageUri }} placeholder={props.blurhash !== undefined ? { blurhash: props.blurhash } : null} contentFit="cover" transition={360} style={StyleSheet.absoluteFill} accessible={false} /> : null}
    </View>
  );
}

/** Rounded 3:4 photo with a small heart on it; name (12pt medium), seller (12pt secondary) and price (14pt tabular) beneath. No box. */
export function ProductCard(props: ImageSlotProps & {
  title: string;
  sellerName?: string | undefined;
  priceText: string;
  priceMinor: bigint;
  claim?: PriceClaimProps | undefined;
  launch?: boolean | undefined;
  launchLabel?: string | undefined;
  saved?: boolean | undefined;
  onToggleSave?: (() => void) | undefined;
  saveLabel?: string | undefined;
  badge?: ReactNode;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
}) {
  const { s } = useTheme();
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={joinLabel(props.title, props.sellerName, props.priceText)} testID={props.testID} scale={0.99}>
      <View style={{ gap: s(8) }}>
        <View>
          <ImageSlot imageUri={props.imageUri} blurhash={props.blurhash} imageNode={props.imageNode} />
          {props.badge ? <View style={{ position: "absolute", top: s(8), start: s(8) }}>{props.badge}</View> : null}
          {props.onToggleSave ? (
            <View style={{ position: "absolute", bottom: s(2), end: s(2) }}>
              <IconButton variant="solid" icon={props.saved === true ? "heart" : "heart-outline"} label={props.saveLabel ?? "Save"} onPress={props.onToggleSave} size={16} />
            </View>
          ) : null}
        </View>
        <View style={{ gap: s(2) }}>
          <Text variant="caption" weight="500" numberOfLines={2} accessibilityRole="none">{props.title}</Text>
          {props.sellerName ? <StoreName name={props.sellerName} /> : null}
          <PriceBlock priceText={props.priceText} priceMinor={props.priceMinor} claim={props.claim} launch={props.launch} launchLabel={props.launchLabel} />
        </View>
      </View>
    </PressScale>
  );
}

export function Avatar(props: { name: string; uri?: string | undefined; node?: ReactNode; size?: number | undefined }) {
  const { colors, s: scale } = useTheme();
  const s = scale(props.size ?? 40);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={props.name} style={{ width: s, height: s, borderRadius: s / 2, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
      {props.node !== undefined ? props.node : props.uri !== undefined ? <Image source={{ uri: props.uri }} contentFit="cover" style={StyleSheet.absoluteFill} accessible={false} /> : <Text variant="caption" weight="500" accessibilityRole="none">{initials(props.name)}</Text>}
    </View>
  );
}

/** Cover image, avatar, name and meta line. */
export function StoreCard(props: { name: string; meta?: string | undefined; coverUri?: string | undefined; coverNode?: ReactNode; avatarUri?: string | undefined; avatarNode?: ReactNode; badge?: ReactNode; onPress?: (() => void) | undefined; testID?: string | undefined }) {
  const { s } = useTheme();
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={joinLabel(props.name, props.meta)} testID={props.testID} scale={0.99}>
      <View style={{ gap: s(10) }}>
        <View>
          <ImageSlot aspectRatio={16 / 10} imageUri={props.coverUri} imageNode={props.coverNode} />
          {props.badge ? <View style={{ position: "absolute", top: s(8), start: s(8) }}>{props.badge}</View> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: s(10) }}>
          <Avatar name={props.name} uri={props.avatarUri} node={props.avatarNode} size={36} />
          <View style={{ flex: 1, gap: s(2) }}>
            <Text variant="headline" weight="400" numberOfLines={1} accessibilityRole="none">{props.name}</Text>
            {props.meta ? <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{props.meta}</Text> : null}
          </View>
        </View>
      </View>
    </PressScale>
  );
}

/** Stars + count. Renders nothing unless it has real data (value in 0..5 and a positive review count). */
export function Rating(props: { value: number | null | undefined; count: number | null | undefined; countText?: string | undefined; label?: string | undefined }) {
  const { s, sc } = useTheme();
  const v = ratingView(props.value, props.count);
  if (!v.show) return null;
  const stars: IconName[] = [0, 1, 2, 3, 4].map((i) => (i < v.filled ? "star" : i === v.filled && v.half ? "star-half" : "star-outline"));
  return (
    <View accessible accessibilityLabel={props.label} style={{ flexDirection: "row", alignItems: "center", gap: s(6) }}>
      <View style={{ flexDirection: "row", gap: 1 }}>{stars.map((n, i) => <Icon key={i} name={n} size={sc(12)} />)}</View>
      {props.countText ? <Text variant="caption" secondary numeric accessibilityRole="none">{props.countText}</Text> : null}
    </View>
  );
}
