import { Children, isValidElement, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Chip, EmptyState, Icon, IconButton, ImageSlot, PressScale, PriceBlock, Reveal, Skeleton, Text, useTheme } from "../../ui";
import { Illustration, ProductArt } from "../../art";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { WORLDS, type World } from "../worlds/model";
import { claimOf, type HomeProduct } from "./model";

export function useFormat() {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const currency = t("common.currency");
  return {
    t,
    locale,
    money: (m: bigint) => formatMoney(m, locale, currency),
    num: (n: number) => localizeDigits(String(n), locale),
    pct: (n: number) => t("home.pctOff", { pct: localizeDigits(String(n), locale) }),
  };
}

export function useOpenProduct(): (id: string) => void {
  const router = useRouter();
  return (id) => router.push({ pathname: "/product/[id]", params: { id } });
}

/** Placeholder art for a listing until sellers upload photography. */
export function productImage(p: Pick<HomeProduct, "id" | "kind">): ReactNode {
  return <ProductArt kind={p.kind} seed={p.id} ratio="3:4" />;
}

/** Minimal product tile: image, seller eyebrow, name, price. Verified claim only through PriceBlock. */
export function ProductTile(props: { product: HomeProduct; width?: number; inset?: number; onOpen: (id: string) => void; saved?: boolean; onSave?: (p: HomeProduct) => void }) {
  const f = useFormat();
  const p = props.product;
  const c = claimOf(p);
  const pad = props.inset ?? 0;
  return (
    <View style={props.width !== undefined ? { width: props.width } : { flex: 1 }}>
    <PressScale
      onPress={() => props.onOpen(p.id)}
      accessibilityRole="button"
      accessibilityLabel={`${p.title}, ${p.storeName}, ${f.money(p.price)}`}
      scale={0.99}
    >
      <View style={{ gap: 6 }}>
        <ImageSlot imageNode={productImage(p)} />
        <View style={{ gap: 2, paddingHorizontal: pad }}>
          {p.sponsored ? <Text variant="caption" weight="600" accessibilityRole="none">{f.t("search.sponsored")}</Text> : null}
          <Text variant="callout" weight="500" numberOfLines={1} accessibilityRole="none">{p.title}</Text>
          <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{p.storeName}</Text>
          <PriceBlock
            priceText={f.money(p.price)}
            priceMinor={p.price}
            launch={p.isLaunchPrice}
            launchLabel={f.t("pdp.launchPrice")}
            verifiedLabel={f.t("pdp.verifiedDiscount", { pct: c !== null ? f.num(c.percent) : "" })}
            {...(c !== null ? { claim: { referenceMinor: c.referencePrice, percent: c.percent, verified: true, referenceText: f.money(c.referencePrice), percentText: f.pct(c.percent) } } : {})}
          />
        </View>
      </View>
    </PressScale>
    {props.onSave !== undefined ? (
      <View style={{ position: "absolute", top: 4, end: 4 }}>
        <IconButton
          variant="glass" size={20} color="onImage" testID={`home-save-${p.id}`}
          icon={props.saved === true ? "heart" : "heart-outline"}
          label={props.saved === true ? f.t("home.saved") : f.t("home.saveItem", { name: p.title })}
          onPress={() => props.onSave?.(p)}
        />
      </View>
    ) : null}
    </View>
  );
}

/** Section head: Inter 600 title with a quiet "See all" action. */
export function SectionTitle(props: { title: string; eyebrow?: string | undefined; reason?: string | undefined; action?: { label: string; onPress: () => void; accessibilityLabel?: string | undefined } | undefined; inset?: number | undefined; /** Optional control shown at the end, next to the action (e.g. the filter icon). */ trailing?: ReactNode | undefined }) {
  const { spacing } = useTheme();
  return (
    <View style={{ paddingHorizontal: props.inset ?? 16 }}>
      {props.eyebrow !== undefined ? <Text variant="eyebrow" secondary accessibilityRole="none">{props.eyebrow}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
        <Text variant="quote" maxScale={1.3} accessibilityRole="header" style={{ flexShrink: 1 }}>{props.title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          {props.trailing ?? null}
          {props.action !== undefined ? (
            <PressScale onPress={props.action.onPress} accessibilityRole="button" accessibilityLabel={props.action.accessibilityLabel ?? props.action.label} hitSlop={8}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text variant="caption" weight="600" secondary accessibilityRole="none">{props.action.label}</Text>
                <Icon name="arrow-forward" size={12} color="textSecondary" directional />
              </View>
            </PressScale>
          ) : null}
        </View>
      </View>
      {props.reason !== undefined ? <Text variant="caption" secondary accessibilityRole="none" testID="section-reason">{props.reason}</Text> : null}
    </View>
  );
}

export function Rail(props: { title: string; eyebrow?: string | undefined; action?: { label: string; onPress: () => void }; itemWidth?: number | undefined; children: ReactNode }) {
  const { spacing } = useTheme();
  const items = Children.toArray(props.children);
  const snap = props.itemWidth !== undefined ? props.itemWidth + 12 : undefined;
  return (
    <View style={{ gap: spacing.sm }}>
      <SectionTitle title={props.title} eyebrow={props.eyebrow} action={props.action} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        {...(snap !== undefined ? { snapToInterval: snap, snapToAlignment: "start" as const } : {})}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
      >
        {items.map((c, i) => <Reveal key={isValidElement(c) && c.key !== null ? c.key : i} index={i}>{c}</Reveal>)}
      </ScrollView>
    </View>
  );
}

/** Two-up grid of rounded product cards inside the 20pt gutter. */
export function ProductGrid(props: { products: readonly HomeProduct[]; onOpen: (id: string) => void }) {
  const rows: HomeProduct[][] = [];
  for (let i = 0; i < props.products.length; i += 2) rows.push(props.products.slice(i, i + 2));
  return (
    <View style={{ gap: 24, paddingHorizontal: 16 }}>
      {rows.map((r, ri) => (
        <Reveal key={r[0]?.id} index={ri} style={{ flexDirection: "row", gap: 14 }}>
          {r.map((p) => <ProductTile key={p.id} product={p} onOpen={props.onOpen} />)}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </Reveal>
      ))}
    </View>
  );
}

export function GridSkeleton(props: { rows?: number }) {
  return (
    <View style={{ gap: 24, paddingHorizontal: 16 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: props.rows ?? 2 }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 14 }}>
          {[0, 1].map((k) => (
            <View key={k} style={{ flex: 1, gap: 10 }}>
              <Skeleton height={230} radius={18} />
              <View style={{ gap: 6 }}><Skeleton width="50%" height={10} /><Skeleton width="80%" height={14} /></View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Worlds switch (spec §3): a chip row, selected chip is the dark fill. Scrolls when labels outgrow the width. */
export function WorldSwitch(props: { world: World; onChange: (w: World) => void }) {
  const { t } = useTranslation();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel={t("worlds.pickerLabel")} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
      {WORLDS.map((w) => (
        <Chip key={w} testID={`world-${w}`} label={t(`home.worldShort.${w}`)} selected={w === props.world} onPress={() => props.onChange(w)} />
      ))}
    </ScrollView>
  );
}

export function WorldEmpty(props: { kind: "noStores" | "noFavourites" | "favouritesHidden"; onWiden?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const k = props.kind;
  return (
    <EmptyState
      illustration={<Illustration name={k === "noStores" ? "noResults" : "emptyWishlist"} size={120} />}
      title={t(k === "noStores" ? "worlds.emptyStoresTitle" : k === "noFavourites" ? "worlds.emptyFavouritesTitle" : "worlds.emptyHiddenTitle")}
      description={t(k === "noStores" ? "worlds.emptyStoresBody" : k === "noFavourites" ? "worlds.emptyFavouritesBody" : "worlds.emptyHiddenBody")}
      {...(props.onWiden !== undefined ? { actionTitle: t("worlds.widen"), onAction: props.onWiden } : {})}
    />
  );
}
