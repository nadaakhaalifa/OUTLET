import { memo, useMemo, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { brand, radius } from "@outlet/ui-tokens";
import { HOME_CARD_RADIUS, dropBanner, dropPageIndex, type HeroDrop } from "../home/model";
import { Icon, PressScale, Text } from "../../ui";
import { HeroArt } from "../../art";
import { Ticker } from "../../components/Ticker";
import { useFormat } from "../home/parts";
import { devImageSource } from "./dev-images";
import { routeForCta, type HomeBanner } from "./model";

/** One shared height for every page of the offer card. */
export const OFFER_CARD_H = 100;
const GUTTER = 16;

type Page =
  | { readonly kind: "promo"; readonly key: string; readonly banner: HomeBanner }
  | { readonly kind: "drop"; readonly key: string; readonly drop: HeroDrop };

/** Pages in order: the promo offer(s), then live drops, then upcoming drops (the caller passes drops already ordered live-first). */
export function offerPages(banners: readonly HomeBanner[], drops: readonly HeroDrop[]): readonly Page[] {
  const live = drops.filter((d) => d.live);
  const upcoming = drops.filter((d) => !d.live);
  return [
    ...banners.map((b): Page => ({ kind: "promo", key: `promo-${b.id}`, banner: b })),
    ...[...live, ...upcoming].map((d): Page => ({ kind: "drop", key: `drop-${d.id}`, drop: d })),
  ];
}

const pad2 = (s: string, ar: boolean) => s.padStart(2, ar ? "٠" : "0");

function Dots(props: { count: number; index: number }) {
  if (props.count < 2) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", bottom: 8, end: 12, flexDirection: "row", gap: 4, alignItems: "center" }} testID="home-offer-dots">
      {Array.from({ length: props.count }, (_, i) => (
        <View key={i} style={{ width: i === props.index ? 12 : 5, height: 5, borderRadius: radius.pill, backgroundColor: brand.ivory, opacity: i === props.index ? 1 : 0.45 }} />
      ))}
    </View>
  );
}

function CardFrame(props: { width: number; children: React.ReactNode; art?: HomeBanner | null; devFixtures?: boolean | undefined }) {
  const b = props.art ?? null;
  const devSrc = b !== null && b.imageUrl === null ? devImageSource(b.devImage, props.devFixtures) : null;
  return (
    <View style={{ width: props.width, height: OFFER_CARD_H, borderRadius: HOME_CARD_RADIUS, overflow: "hidden", backgroundColor: brand.ink }}>
      {b !== null && b.promoPercentLabel === null ? <HeroArt variant={b.art} aspect={props.width / OFFER_CARD_H} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} /> : null}
      {b !== null && b.imageUrl !== null ? <Image source={{ uri: b.imageUrl }} contentFit="cover" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} accessibilityElementsHidden /> : null}
      {devSrc !== null ? <Image source={devSrc} contentFit="cover" style={{ position: "absolute", top: 0, bottom: 0, end: 0, width: "58%" }} accessibilityElementsHidden /> : null}
      <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} colors={[brand.ink + "FF", brand.ink + "F2", brand.ink + "26"]} locations={[0, 0.5, 0.85]} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
      <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8, justifyContent: "center", gap: 2 }}>{props.children}</View>
    </View>
  );
}

function PromoPage(props: { banner: HomeBanner; width: number; devFixtures: boolean | undefined; onOpen: () => void }) {
  const f = useFormat();
  const b = props.banner;
  const title = b.title[f.locale];
  const sub = b.subtitle !== null ? b.subtitle[f.locale] : null;
  const percent = b.promoPercentLabel;
  return (
    <PressScale
      onPress={props.onOpen}
      accessibilityRole="button"
      accessibilityLabel={[b.sponsored ? f.t("homeBanners.sponsored") : null, percent !== null ? `${f.t("homeBanners.upTo")} ${percent} ${f.t("homeBanners.off")}` : title, percent !== null ? title : sub].filter((x): x is string => x !== null).join(", ")}
      testID={`home-promo-${b.id}`}
      scale={0.98}
      style={{ width: props.width }}
    >
      <CardFrame width={props.width} art={b} devFixtures={props.devFixtures}>
        {percent !== null ? (
          <Text variant="offer" numberOfLines={1} maxScale={1.2} style={{ color: brand.ivory }} accessibilityRole="none">
            <Text variant="offer" style={{ color: brand.ivory, opacity: 0.85 }} accessibilityRole="none">{`${f.t("homeBanners.upTo").toUpperCase()} `}</Text>
            {`${percent} ${f.t("homeBanners.off").toUpperCase()}`}
          </Text>
        ) : <Text variant="offer" numberOfLines={1} maxScale={1.2} style={{ color: brand.ivory }} accessibilityRole="none">{title}</Text>}
        {percent !== null ? <Text variant="caption" numberOfLines={1} style={{ color: brand.ivory, opacity: 0.92 }} accessibilityRole="none">{title}</Text>
          : sub !== null ? <Text variant="caption" numberOfLines={1} style={{ color: brand.ivory, opacity: 0.92 }} accessibilityRole="none">{sub}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 }}>
          <Text variant="eyebrow" weight="600" style={{ color: brand.ivory }} accessibilityRole="none">{f.t("homeBanners.shopOffer")}</Text>
          <Icon name="arrow-forward" size={14} color="onImage" directional />
        </View>
        {b.sponsored ? <View style={{ position: "absolute", top: 6, end: 12 }}><Text variant="eyebrow" style={{ color: brand.ivory }} accessibilityRole="none">{f.t("homeBanners.adTag")}</Text></View> : null}
      </CardFrame>
    </PressScale>
  );
}

function DropPage(props: { drop: HeroDrop; width: number; nowFn: () => number; onOpen: (id: string) => void }) {
  const f = useFormat();
  const d = props.drop;
  const ar = f.locale === "ar";
  return (
    <Ticker nowFn={props.nowFn} render={(nowMs) => {
      const b = dropBanner(d, nowMs);
      const live = b !== null ? b.live : d.live;
      const c = b !== null ? b.countdown : null;
      const status = f.t(live ? "shopAll.bannerLive" : "shopAll.bannerUpcoming");
      const clock = c !== null ? [c.days, c.hours, c.minutes, c.seconds].map((n) => pad2(f.num(n), ar)).join(":") : null;
      const store = d.storeName.length > 0 ? d.storeName : null;
      return (
        <PressScale
          onPress={() => props.onOpen(d.id)}
          accessibilityRole="button"
          accessibilityLabel={`${status}. ${d.title}${store !== null ? `, ${store}` : ""}`}
          testID={`home-drop-${d.id}`}
          scale={0.98}
          style={{ width: props.width }}
        >
          <CardFrame width={props.width}>
            <View style={{ position: "absolute", top: 0, bottom: 0, end: 0, width: "34%", opacity: 0.55 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <HeroArt variant={d.variant} aspect={0.8} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
            </View>
            <Text variant="eyebrow" style={{ color: brand.ivory, opacity: 0.85 }} accessibilityRole="none">{status}</Text>
            <Text variant="offer" numberOfLines={1} maxScale={1.2} style={{ color: brand.ivory }} accessibilityRole="none">{d.title}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8 }}>
              {store !== null ? <Text variant="caption" numberOfLines={1} style={{ color: brand.ivory, opacity: 0.92, flexShrink: 1 }} accessibilityRole="none">{store}</Text> : null}
              {clock !== null ? <Text variant="caption" weight="600" numeric accessibilityRole="timer" style={{ color: brand.ivory }}>{clock}</Text> : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 }}>
              <Text variant="eyebrow" weight="600" style={{ color: brand.ivory }} accessibilityRole="none">{f.t("homeBanners.viewDrop")}</Text>
              <Icon name="arrow-forward" size={14} color="onImage" directional />
            </View>
          </CardFrame>
        </PressScale>
      );
    }} />
  );
}

/**
 * The dark offer card: swipeable pages (promo offer, then live drops, then upcoming drops) of one fixed height.
 * Real data only; drop countdowns tick from the server clock. A single page when there are no drops.
 */
export const PromoBanners = memo(function PromoBanners(props: {
  banners: readonly HomeBanner[]; drops?: readonly HeroDrop[] | undefined; nowFn?: (() => number) | undefined;
  onOpenDrop?: ((id: string) => void) | undefined; devFixtures?: boolean | undefined;
}) {
  const f = useFormat();
  const router = useRouter();
  const { width: win } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const pages = useMemo(() => offerPages(props.banners, props.drops ?? []), [props.banners, props.drops]);
  if (pages.length === 0) return null;
  const w = win - GUTTER * 2;
  const nowFn = props.nowFn ?? Date.now;
  const open = props.onOpenDrop ?? ((id: string) => router.push({ pathname: "/drops", params: { id } }));
  const cur = Math.min(index, pages.length - 1);
  const render = (p: Page) => p.kind === "promo"
    ? <PromoPage key={p.key} banner={p.banner} width={w} devFixtures={props.devFixtures} onOpen={() => router.push(routeForCta(p.banner.cta) as never)} />
    : <DropPage key={p.key} drop={p.drop} width={w} nowFn={nowFn} onOpen={open} />;
  return (
    <View style={{ paddingHorizontal: GUTTER }} testID="home-promo-banners" accessibilityLabel={f.t("homeBanners.promoRegion")}>
      <View style={{ width: w, height: OFFER_CARD_H, borderRadius: HOME_CARD_RADIUS, overflow: "hidden" }}>
        {pages.length === 1 ? (
          pages[0] !== undefined ? render(pages[0]) : null
        ) : (
          <ScrollView
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onMomentumScrollEnd={(e) => setIndex(dropPageIndex(Math.abs(e.nativeEvent.contentOffset.x), w, pages.length, 0))}
            testID="home-offer-pager"
          >
            {pages.map(render)}
          </ScrollView>
        )}
        <Dots count={pages.length} index={cur} />
      </View>
    </View>
  );
});
