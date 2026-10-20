import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { radius } from "@outlet/ui-tokens";
import { Icon, PressScale, StoreName, Text, useTheme } from "../../ui";
import { claimOf } from "../home/model";
import { productImage, useFormat } from "../home/parts";
import { inferKind } from "../home/model";
import { formatAmount } from "../money-display";
import { DEV_SEARCH_PHOTOS } from "./dev-fixtures";
import type { SearchItem } from "./model";

/** Flat board product card: photo with dark discount pill and heart, store name (bold, never uppercased), name, price and strike-through. */
function ResultCard(props: { item: SearchItem; onOpen: (id: string) => void }) {
  const f = useFormat();
  const { colors } = useTheme();
  const [saved, setSaved] = useState(false);
  const it = props.item;
  const currency = f.t("common.currency");
  /** Board arrangement: symbol first in English (EGP 79.99); Arabic keeps the label last. */
  const money = (m: bigint) => (f.locale === "en" ? `${currency} ${formatAmount(m, f.locale)}` : f.money(m));
  const claim = claimOf({ price: it.price, referencePrice: it.referencePrice ?? null, verifiedPct: it.verifiedDiscountPct });
  const photo = DEV_SEARCH_PHOTOS !== null && it.devPhoto !== undefined ? DEV_SEARCH_PHOTOS[it.devPhoto] : undefined;
  const brand = it.brand === undefined ? it.storeName : it.brand;
  return (
    <PressScale
      onPress={() => props.onOpen(it.id)}
      accessibilityRole="button"
      accessibilityLabel={`${it.title}, ${it.storeName}, ${money(it.price)}`}
      scale={0.99}
      style={{ flex: 1 }}
    >
      <View style={{ gap: 6 }}>
        <View style={{ aspectRatio: 1.1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.fill }}>
          {photo !== undefined
            ? <Image source={photo} resizeMode="cover" style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors />
            : productImage({ id: it.id, kind: inferKind(it.title) })}
          {claim !== null ? (
            <View style={{ position: "absolute", top: 8, start: 8, backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text variant="caption" weight="600" style={{ color: colors.background }} accessibilityRole="none">{f.pct(claim.percent)}</Text>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={f.t("home.saveItem", { name: it.title })}
            accessibilityState={{ selected: saved }}
            hitSlop={12}
            onPress={() => setSaved(!saved)}
            style={{ position: "absolute", top: 6, end: 6, width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name={saved ? "heart" : "heart-outline"} size={18} color={saved ? "danger" : "onImage"} />
          </Pressable>
        </View>
        <View style={{ gap: 2, paddingTop: 4 }}>
          {it.sponsored ? <Text variant="caption" weight="600" accessibilityRole="none">{f.t("search.sponsored")}</Text> : null}
          {brand !== null && brand.length > 0 ? (
            <StoreName name={brand} layout="tile" />
          ) : null}
          <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{it.title}</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingTop: 4 }}>
            <Text variant="callout" weight="600" numeric accessibilityRole="none">{money(it.price)}</Text>
            {claim !== null ? (
              <Text variant="caption" secondary numeric style={{ textDecorationLine: "line-through" }} accessibilityRole="none">{money(claim.referencePrice)}</Text>
            ) : null}
          </View>
        </View>
      </View>
    </PressScale>
  );
}

/** Two-column grid, 20pt gutter, 16pt gaps (board screen 7). */
export function BoardResults(props: { items: readonly SearchItem[]; onOpen: (id: string) => void }) {
  const rows: SearchItem[][] = [];
  for (let i = 0; i < props.items.length; i += 2) rows.push(props.items.slice(i, i + 2));
  return (
    <View style={{ gap: 20, paddingHorizontal: 20 }}>
      {rows.map((r) => (
        <View key={r[0]?.id} style={{ flexDirection: "row", gap: 16 }}>
          {r.map((it) => <ResultCard key={it.id} item={it} onOpen={props.onOpen} />)}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}
