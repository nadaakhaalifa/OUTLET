import { View } from "react-native";
import { brand } from "@outlet/ui-tokens";
import { Icon, PressScale, Reveal, StoreName, Text, useTheme } from "../../ui";
import { HeroArt, StoreAvatar } from "../../art";
import type { StoreSummary } from "../worlds/model";
import type { DropBanner } from "./model";
import { useFormat } from "./parts";

/** Compact DD:HH:MM:SS from server time (small, tabular). */
export function DropClock(props: { c: NonNullable<DropBanner["countdown"]> }) {
  const f = useFormat();
  const two = (n: number) => f.num(n).padStart(2, f.locale === "ar" ? "٠" : "0");
  const { days, hours, minutes, seconds } = props.c;
  return (
    <Text variant="caption" weight="600" numeric accessibilityRole="timer" style={{ letterSpacing: 0.5 }}>
      {`${two(days)}:${two(hours)}:${two(minutes)}:${two(seconds)}`}
    </Text>
  );
}

/** Wide, short banner for the next real drop. The whole banner opens the drop. */
export function DropBannerView(props: { banner: DropBanner; onPress: () => void }) {
  const f = useFormat();
  const { colors } = useTheme();
  const b = props.banner;
  const label = b.countdown !== null
    ? f.t("shopAll.bannerA11y", { title: b.title, store: b.storeName, d: f.num(b.countdown.days), h: f.num(b.countdown.hours), m: f.num(b.countdown.minutes) })
    : f.t("shopAll.bannerLiveA11y", { title: b.title, store: b.storeName });
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={label} testID="home-drop-banner" scale={0.99}>
      <View style={{ minHeight: 100, borderRadius: 18, overflow: "hidden", flexDirection: "row", alignItems: "stretch", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline }}>
        <View style={{ width: 96, overflow: "hidden" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <HeroArt variant={b.variant} aspect={0.96} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
        </View>
        <View style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 10, justifyContent: "center", gap: 2 }}>
          <Text variant="eyebrow" secondary accessibilityRole="none">{b.live ? f.t("shopAll.bannerLive") : f.t("shopAll.bannerUpcoming")}</Text>
          <Text variant="callout" weight="600" numberOfLines={2} accessibilityRole="none">{b.title}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 8 }}>
            <Text variant="caption" secondary numberOfLines={2} style={{ flexShrink: 1 }} accessibilityRole="none">{b.storeName}</Text>
            {b.countdown !== null ? <DropClock c={b.countdown} /> : null}
          </View>
        </View>
        <View style={{ justifyContent: "center", paddingEnd: 12 }}>
          <Icon name="chevron-forward" size={18} color="textSecondary" directional />
        </View>
      </View>
    </PressScale>
  );
}

/** One store per row: avatar, name, verified badge, verified discount and rating only when real, chevron. */
export function StoreListRow(props: { store: StoreSummary; index: number; onPress: () => void }) {
  const f = useFormat();
  const { colors } = useTheme();
  const s = props.store;
  const meta: string[] = [];
  if (s.maxVerifiedDiscountPct !== null) meta.push(f.t("worlds.discountUpTo", { pct: f.num(s.maxVerifiedDiscountPct) }));
  if (s.rating !== null) meta.push(f.t("shopAll.ratingValue", { rating: f.num(Math.round(s.rating * 10) / 10) }));
  return (
    <Reveal index={props.index}>
      <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={f.t("shopAll.openStore", { name: s.name })} testID={`home-store-${s.id}`} scale={0.99}
        innerStyle={{ minHeight: 72, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
        <View style={{ borderRadius: 14, overflow: "hidden" }}><StoreAvatar name={s.name} seed={s.id} size={52} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ flexShrink: 1 }}><StoreName name={s.name} verified={s.verified} verifiedLabel={f.t("storeName.verified")} layout="row" /></View>
            {s.liveDrop ? <Text variant="eyebrow" color="danger" accessibilityRole="none">{f.t("worlds.liveDrop")}</Text> : null}
          </View>
          {meta.length > 0 ? <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{meta.join("  ·  ")}</Text> : null}
        </View>
        <Icon name="chevron-forward" size={18} color="textSecondary" directional />
      </PressScale>
    </Reveal>
  );
}

/** Prominent entry to the catalogue. Deep teal fill (same in light and dark) with an ivory serif title and an arrow disc. */
export function ShopEverythingEntry(props: { onPress: () => void; testID?: string }) {
  const f = useFormat();
  const { colors } = useTheme();
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={f.t("shopAll.entryTitle")} accessibilityHint={f.t("shopAll.entryBody")} testID={props.testID ?? "shop-everything"} scale={0.99}>
      <View style={{ minHeight: 84, borderRadius: 18, paddingStart: 18, paddingEnd: 14, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: brand.teal }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="quote" weight="600" numberOfLines={2} maxScale={1.4} style={{ color: brand.ivory }} accessibilityRole="none">{f.t("shopAll.entryTitle")}</Text>
          <Text variant="caption" numberOfLines={4} style={{ color: brand.ivory, opacity: 0.8 }} accessibilityRole="none">{f.t("shopAll.entryBody")}</Text>
        </View>
        <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}>
          <Icon name="arrow-forward" size={20} color="onAccent" directional />
        </View>
      </View>
    </PressScale>
  );
}
