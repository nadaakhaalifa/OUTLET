import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Illustration, ProductArt } from "../../art";
import { Badge, Button, EmptyState, ImageSlot, PressScale, Reveal, Screen, SearchField, Skeleton, Text, Chip } from "../../ui";
import { localizeDigits } from "../money-display";
import { FailureView, StaleBanner, useBrand, useLoad, useMoney } from "./kit";
import { can, filterProducts, type BrandProduct, type ProductFilter } from "./model";

const FILTERS: readonly ProductFilter[] = ["all", "active", "draft", "paused", "lowStock"];

export function ProductsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { port, account, locale } = useBrand();
  const money = useMoney();
  const { state, reload } = useLoad<readonly BrandProduct[]>("products", () => port.listProducts());
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [query, setQuery] = useState("");
  const canAdd = can(account.role, "catalog_write");
  const items = useMemo(() => (state.status === "ready" ? filterProducts(state.data, filter, query) : []), [state, filter, query]);
  const add = () => router.push("/brand-mode/product-edit");

  return (
    <Screen title={t("brandMode.products.title")} onRefresh={reload}>
      {state.status === "ready" ? <StaleBanner visible={state.stale} /> : null}
      {state.status === "loading" ? <ListSkeleton /> : null}
      {state.status === "error" ? <FailureView failure={state.failure} onRetry={reload} /> : null}
      {state.status === "ready" && state.data.length === 0 ? (
        <EmptyState illustration={<Illustration name="emptyBag" size={96} />} title={t("brandMode.products.emptyTitle")} description={t("brandMode.products.emptyBody")}
          actionTitle={canAdd ? t("brandMode.products.add") : undefined} onAction={canAdd ? add : undefined} />
      ) : null}
      {state.status === "ready" && state.data.length > 0 ? (
        <>
          {canAdd ? <Button title={t("brandMode.products.add")} icon="add" onPress={add} testID="brand-add-product" /> : null}
          <SearchField placeholder={t("brandMode.products.search")} value={query} onChangeText={setQuery} testID="brand-product-search" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
            {FILTERS.map((f) => <Chip key={f} label={t(`brandMode.products.filters.${f}`)} selected={filter === f} onPress={() => setFilter(f)} />)}
          </ScrollView>
          {items.length === 0 ? <EmptyState illustration={<Illustration name="noResults" size={88} />} title={t("brandMode.products.noResultsTitle")} description={t("brandMode.products.noResultsBody")} /> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 28 }}>
            {items.map((p, i) => (
              <Reveal key={p.id} index={i % 8} style={{ width: "47.5%", flexGrow: 1 }}>
                <ProductRow p={p} locale={locale} money={money} onPress={() => router.push({ pathname: "/brand-mode/product-edit", params: { id: p.id } })} />
              </Reveal>
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function ProductRow(props: { p: BrandProduct; locale: "ar" | "en"; money: (m: bigint) => string; onPress: () => void }) {
  const { t } = useTranslation();
  const { p } = props;
  const title = props.locale === "en" ? (p.titleEn ?? p.titleAr) : p.titleAr;
  const n = (v: number) => localizeDigits(String(v), props.locale);
  const kind = p.titleAr.includes("حذاء") ? "heel" : p.titleAr.includes("حقيبة") ? "bag" : p.titleAr.includes("قميص") ? "shirt" : "dress";
  const live = p.status === "active";
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${t(`brandMode.products.status.${p.status}`)}`}>
      <View style={{ gap: 10 }}>
        <ImageSlot style={{ width: "100%" }} imageUri={p.coverUri ?? undefined} imageNode={p.coverUri === null ? <ProductArt kind={kind} seed={p.id} ratio="3:4" /> : undefined} />
        <View style={{ gap: 4 }}>
          <Text variant="callout" numberOfLines={2}>{title}</Text>
          <Text variant="headline" weight="600" numeric secondary={p.priceFrom === null}>{p.priceFrom === null ? t("brandMode.products.noPrice") : props.money(p.priceFrom)}</Text>
          <Text variant="caption" secondary>{t("brandMode.products.meta", { sizes: n(p.sizes), stock: n(p.totalStock) })}</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Badge label={t(`brandMode.products.status.${p.status}`)} kind={live ? "verified" : "neutral"} />
            {p.claim !== "none" ? <Badge label={t(`brandMode.products.claim.${p.claim}`)} kind={p.claim === "verified_discount" ? "verified" : p.claim === "lowest_30d" ? "lowest30" : "launch"} /> : null}
          </View>
        </View>
      </View>
    </PressScale>
  );
}

function ListSkeleton() {
  return (
    <View style={{ gap: 16 }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: "row", gap: 16 }}>
          <Skeleton width={64} height={85} radius={18} />
          <View style={{ flex: 1, gap: 10 }}><Skeleton height={16} width="70%" /><Skeleton height={14} width="40%" /><Skeleton height={12} width="55%" /></View>
        </View>
      ))}
    </View>
  );
}
