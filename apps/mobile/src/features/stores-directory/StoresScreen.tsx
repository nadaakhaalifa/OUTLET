import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FabricBackdrop } from "../../components/FabricBackdrop";
import { AccessibilityInfo, Image, ScrollView, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, radius } from "@outlet/ui-tokens";
import { Chip, EmptyState, ErrorState, Icon, IconButton, type IconName, PressScale, SearchField, Skeleton, StoreName, Text, useTheme } from "../../ui";
import { Illustration, StoreCover } from "../../art";
import { getFeaturePorts } from "../../state/ports";
import { localizeDigits } from "../money-display";
import { pluralKey } from "../../i18n/plural";
import {
  EMPTY_DIRECTORY_FILTER, PortError, filterStores, locationCounts, locationFilterCount, outletsChrome, pluralForm, scopeToWorld, sortStores, toCardView,
  type DirectoryFilter, type LocationSelection, type OutletLocations, type ShopScope, type StoresDirectoryPort, type StoreSummary,
} from "./model";
import { CHIP_ROW_PAD_V } from "../shop-all/model";
import { devOutletsFixture } from "./dev-fixtures";
import { areaById, governorateById, nameOf } from "./egypt-areas";
import { LocationSheet } from "./LocationSheet";

type Phase = { kind: "loading" } | { kind: "error"; offline: boolean } | { kind: "ready"; stores: readonly StoreSummary[] };

const SCOPE_KEY: Record<ShopScope, string> = { local: "storesDir.scopeLocal", global: "storesDir.scopeGlobal", both: "storesDir.scopeBoth" };

function MetaRow(props: { icon: IconName; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={props.icon} size={14} color="textPrimary" />
      <Text variant="caption" weight="600" numberOfLines={1} accessibilityRole="none" style={{ flexShrink: 1 }}>{props.text}</Text>
    </View>
  );
}

/** Step 3: the shops list for the chosen scope. Tapping a store opens its collection. */
export function StoresScreen(props: { port?: StoresDirectoryPort; scope?: ShopScope; variant?: "online" | "outlets" }) {
  const outlets = props.variant === "outlets";
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scope: ShopScope = props.scope ?? "both";
  const port = useMemo<StoresDirectoryPort>(() => props.port ?? getFeaturePorts().worlds, [props.port]);
  const locale = i18n.language === "en" ? "en" : "ar";
  const num = useCallback((n: number) => localizeDigits(String(n), locale), [locale]);

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState<LocationSelection>({ governorateId: null, areaIds: [] });
  const [sheet, setSheet] = useState(false);

  const load = useCallback(async () => {
    if (outlets) { setPhase({ kind: "ready", stores: [] }); return; }
    setPhase({ kind: "loading" });
    try {
      setPhase({ kind: "ready", stores: await port.listStores() });
    } catch (e) {
      setPhase({ kind: "error", offline: e instanceof PortError && e.kind === "offline" });
    }
  }, [port, outlets]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const h = setTimeout(() => setQuery(typed), 250);
    return () => clearTimeout(h);
  }, [typed]);

  const dev = useMemo(() => (outlets ? devOutletsFixture() : null), [outlets]);
  const locations = useMemo<OutletLocations>(() => {
    const out: Record<string, { governorateId: string | null; areaId: string | null }> = {};
    for (const [id, x] of Object.entries(dev?.extras ?? {})) out[id] = { governorateId: x.governorateId ?? null, areaId: x.areaId ?? null };
    return out;
  }, [dev]);
  const outletFilter = useMemo<DirectoryFilter>(
    () => ({ ...EMPTY_DIRECTORY_FILTER, query, world: outlets ? "all" : scopeToWorld(scope), governorateId: location.governorateId, areaIds: location.areaIds }),
    [query, scope, outlets, location],
  );
  const sourceStores = useMemo<readonly StoreSummary[]>(() => (outlets ? (dev?.stores ?? []) : phase.kind === "ready" ? phase.stores : []), [outlets, dev, phase]);
  const rows = useMemo(() => {
    if (phase.kind !== "ready") return [];
    return sortStores(filterStores(sourceStores, outletFilter, locations), "trending");
  }, [phase, sourceStores, outletFilter, locations]);
  const counts = useMemo(() => locationCounts(sourceStores, locations, outletFilter), [sourceStores, locations, outletFilter]);
  const locCount = locationFilterCount(location);
  const widenName = (() => { const g = location.governorateId === null ? undefined : governorateById(location.governorateId); return g === undefined ? "" : nameOf(g, locale); })();
  const clearLocation = () => setLocation({ governorateId: null, areaIds: [] });
  const hasCities = rows.some((s) => (dev?.extras[s.id]?.city ?? null) !== null);

  const chrome = outletsChrome(outlets, dev !== null);
  // Screen readers hear the new outlet count once the filters settle.
  const countText = outlets && chrome.filterButton && phase.kind === "ready" ? t(pluralKey("storesDir.count", rows.length), { n: num(rows.length) }) : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (countText === null) return undefined;
    const previous = announced.current;
    announced.current = countText;
    if (previous === null || previous === countText) return undefined;
    const h = setTimeout(() => AccessibilityInfo.announceForAccessibility(countText), 500);
    return () => clearTimeout(h);
  }, [countText]);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/stores"));
  const origin = !outlets;

  const hero = (
    <PressScale
      onPress={() => router.push({ pathname: "/shop-all" })}
      accessibilityRole="button"
      accessibilityLabel={`${t("storesDir.heroNearestTitle")}. ${t("storesDir.heroNearestBody")}`}
      testID="stores-hero"
      scale={0.99}
      innerStyle={{ height: 178, marginBottom: 20, borderRadius: radius.xl, backgroundColor: colors.accent, overflow: "hidden" }}
    >
      {dev !== null ? <Image source={dev.heroPhoto} resizeMode="cover" accessibilityIgnoresInvertColors accessibilityElementsHidden importantForAccessibility="no" style={{ position: "absolute", top: 0, end: 0, height: 178, width: "34%" }} /> : null}
      <View style={{ flex: 1, padding: 22, justifyContent: "center", paddingEnd: 150 }}>
        <Text variant="title1" color="onAccent" accessibilityRole="none">{t("storesDir.heroNearestTitle")}</Text>
        <Text variant="caption" color="onAccent" accessibilityRole="none" style={{ marginTop: 10 }}>{t("storesDir.heroNearestBody")}</Text>
      </View>
      <View style={{ position: "absolute", end: 16, bottom: 16, width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.onAccent, alignItems: "center", justifyContent: "center" }}>
        <Icon name="arrow-forward" size={18} color="onAccent" directional />
      </View>
    </PressScale>
  );

  let body;
  if (phase.kind === "loading") {
    body = (
      <View accessible accessibilityRole="progressbar" style={{ gap: 14 }} accessibilityLabel={t("storesDir.loading")} testID="stores-loading">
        {[0, 1, 2, 3, 4].map((k) => (
          <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <Skeleton width={56} height={56} radius={16} />
            <View style={{ flex: 1, gap: 8 }}><Skeleton width="55%" height={14} /><Skeleton width="35%" height={11} /></View>
          </View>
        ))}
      </View>
    );
  } else if (phase.kind === "error") {
    body = <ErrorState offline={phase.offline} title={t(phase.offline ? "storesDir.offlineTitle" : "storesDir.errorTitle")} description={t(phase.offline ? "storesDir.offlineBody" : "storesDir.errorBody")} retryTitle={t("storesDir.retry")} onRetry={() => void load()} />;
  } else if (rows.length === 0) {
    const none = outlets && dev === null;
    const locationEmpty = outlets && !none && locCount > 0;
    body = locationEmpty ? (
      <View style={{ gap: 12 }} testID="stores-location-empty">
        <EmptyState illustration={<Illustration name="noResults" size={120} />} title={t("storesDir.filter.noMatchTitle")} description={t("storesDir.filter.noMatchBody")}
          actionTitle={location.areaIds.length > 0 ? t("storesDir.filter.widen", { name: widenName }) : t("storesDir.filter.clearAll")}
          onAction={location.areaIds.length > 0 ? () => setLocation({ governorateId: location.governorateId, areaIds: [] }) : clearLocation} />
        {location.areaIds.length > 0 ? <View style={{ alignItems: "center" }}><Chip label={t("storesDir.filter.clearAll")} onPress={clearLocation} testID="stores-location-empty-clear" /></View> : null}
      </View>
    ) : none ? (
      <EmptyState illustration={<Illustration name="noResults" size={120} />} title={t("storesDir.inStoreTitle")} description={t("storesDir.inStoreBody")} actionTitle={t("storesDir.inStoreAction")} onAction={() => router.replace("/stores")} />
    ) : (
      <EmptyState illustration={<Illustration name="noResults" size={120} />} title={t("storesDir.emptyTitle")} description={t("storesDir.emptyBody")} />
    );
  } else {
    body = (
      <FlashList
        data={rows}
        keyExtractor={(s) => s.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={chrome.hero ? hero : null}
        renderItem={({ item: s }) => {
          const x = outlets ? dev?.extras[s.id] : undefined;
          const area = x?.areaId !== null && x?.areaId !== undefined ? areaById(x.areaId) : undefined;
          const v = toCardView(s, x !== undefined && area !== undefined ? { ...x, city: nameOf(area, locale) } : x);
          const sep = locale === "ar" ? "، " : ", ";
          const distanceText = outlets && v.distanceKm !== null ? t("storesDir.distanceKm", { n: num(v.distanceKm) }) : null;
          const openText = outlets && v.openNow !== null ? [t(v.openNow ? "storesDir.openNow" : "storesDir.closedNow"), v.closesAt !== null ? t("storesDir.closesAt", { time: v.closesAt }) : null] : null;
          const rowLabel = [
            v.name,
            outlets ? v.locationLine : null,
            origin ? t(v.kind === "local" ? "storesDir.tagLocal" : "storesDir.tagGlobal") : null,
            openText !== null ? openText.filter((x): x is string => x !== null).join(sep) : outlets ? v.hoursText : null,
            distanceText,
            v.verifiedDiscountPct !== null ? t("worlds.discountUpTo", { pct: num(v.verifiedDiscountPct) }) : null,
            v.deliveryDays !== null ? t("storesDir.cardDelivery", { days: num(v.deliveryDays) }) : null,
            v.rating !== null ? t("storesDir.cardRating", { value: num(v.rating) }) : null,
          ].filter((x): x is string => x !== null && x.length > 0).join(sep);
          return (
            <PressScale
              onPress={() => router.push({ pathname: "/shop-all", params: { store: v.id } })}
              accessibilityRole="button"
              accessibilityLabel={rowLabel}
              accessibilityHint={t("storesDir.openStore", { name: v.name })}
              testID={`stores-row-${v.id}`}
              scale={0.99}
              innerStyle={{ flexDirection: "row", alignItems: "stretch", gap: 14, padding: 8, marginBottom: 16, borderRadius: radius.lg, borderWidth: 2, borderColor: brand.teal + "73", backgroundColor: colors.surface }}
            >
              <View style={{ width: 124, height: 124, borderRadius: radius.md, overflow: "hidden" }}>
                {x !== undefined ? <Image source={x.photo} resizeMode="cover" accessibilityIgnoresInvertColors accessibilityElementsHidden importantForAccessibility="no" style={{ width: "100%", height: "100%" }} /> : <StoreCover seed={v.id} aspect={1} />}
              </View>
              <View style={{ flex: 1, gap: 6, paddingTop: 8 }}>
                <StoreName name={v.name} verified={s.verified} verifiedLabel={t("storeName.verified")} layout="row" testID={`stores-name-${v.id}`} />
                {outlets && v.locationLine !== null ? <Text variant="caption" weight="600" numberOfLines={1} accessibilityRole="none">{v.locationLine}</Text> : null}
                {origin ? <Text variant="caption" weight="600" numberOfLines={1} accessibilityRole="none">{t(v.kind === "local" ? "storesDir.tagLocal" : "storesDir.tagGlobal")}</Text> : null}
                {outlets && v.openNow !== null ? (
                  <Text variant="caption" numberOfLines={1} accessibilityRole="none">
                    <Text variant="callout" weight="600" accessibilityRole="none" style={{ color: v.openNow ? colors.savings : colors.textSecondary }}>{t(v.openNow ? "storesDir.openNow" : "storesDir.closedNow")}</Text>
                    {v.closesAt !== null ? <Text variant="caption" weight="600" accessibilityRole="none">{`  •  ${t("storesDir.closesAt", { time: v.closesAt })}`}</Text> : null}
                  </Text>
                ) : outlets && v.hoursText !== null ? <MetaRow icon="time-outline" text={v.hoursText} /> : null}
                {outlets && v.distanceKm !== null ? <MetaRow icon="location-outline" text={t("storesDir.distanceKm", { n: num(v.distanceKm) })} /> : null}
                {v.verifiedDiscountPct !== null ? <MetaRow icon="pricetag-outline" text={t("worlds.discountUpTo", { pct: num(v.verifiedDiscountPct) })} /> : null}
                {v.deliveryDays !== null ? <MetaRow icon="bicycle-outline" text={t("storesDir.cardDelivery", { days: num(v.deliveryDays) })} /> : null}
                {v.rating !== null ? <MetaRow icon="star-outline" text={t("storesDir.cardRating", { value: num(v.rating) })} /> : null}
              </View>
              <View style={{ paddingTop: 8, paddingEnd: 6 }}><Icon name="chevron-forward" size={16} color="textSecondary" directional /></View>
            </PressScale>
          );
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 4, paddingHorizontal: 20 }} testID="stores-screen">
      <FabricBackdrop soft />
      <View style={{ marginStart: -12 }}>
        <IconButton variant="plain" icon="chevron-back" directional label={t("storesDir.back")} onPress={back} testID="stores-back" />
      </View>
      <Text variant="title1" weight="600" accessibilityRole="header" style={{ paddingBottom: 16 }}>{t(outlets ? "storesDir.outletsTitle" : "storesDir.onlineListTitle")}</Text>
      {outlets ? null : <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 12 }}>
        <Text variant="caption" secondary testID="stores-scope-label">{t("storesDir.scopeLabel", { scope: t(SCOPE_KEY[scope]) })}</Text>
        <PressScale onPress={() => router.replace("/stores")} accessibilityRole="button" accessibilityLabel={t("storesDir.scopeChange")} testID="stores-scope-change" hitSlop={12} innerStyle={{ minHeight: 44, justifyContent: "center" }}>
          <Text variant="callout" weight="600" accessibilityRole="none">{t("storesDir.scopeChange")}</Text>
        </PressScale>
      </View>}
      <View style={{ paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <SearchField value={typed} onChangeText={setTyped} placeholder={t(outlets && hasCities ? "storesDir.searchPlaceholderOutlets" : "storesDir.searchPlaceholder")} label={t("storesDir.searchLabel")} clearLabel={t("storesDir.clear")} testID="stores-search" />
        </View>
        {chrome.filterButton ? (
          <View>
            <IconButton variant="solid" icon="funnel-outline" label={locCount > 0 ? t("storesDir.filter.buttonLabelCount", { count: num(locCount) }) : t("storesDir.filter.buttonLabel")} onPress={() => setSheet(true)} testID="stores-filter-button" />
            {locCount > 0 ? (
              <View pointerEvents="none" style={{ position: "absolute", top: 2, end: 2, minWidth: 20, height: 20, borderRadius: radius.pill, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}>
                <Text variant="caption" weight="600" style={{ color: colors.background }} accessibilityRole="none" testID="stores-filter-badge">{num(locCount)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      {outlets && locCount > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 12 }} contentContainerStyle={{ gap: 8, alignItems: "center", paddingVertical: CHIP_ROW_PAD_V }} testID="stores-applied">
          <Text variant="caption" weight="600" accessibilityRole="header" testID="stores-applied-count">{t(`storesDir.filter.applied${pluralForm(locCount)}`, { n: num(locCount) })}</Text>
          {location.governorateId !== null ? (() => {
            const g = governorateById(location.governorateId);
            const name = g === undefined ? location.governorateId : nameOf(g, locale);
            return <Chip label={name} icon="close" selected accessibilitySelected={false} accessibilityLabel={t("storesDir.filter.remove", { name })} onPress={clearLocation} testID="stores-applied-gov" />;
          })() : null}
          {location.areaIds.map((id) => {
            const ar = areaById(id);
            const name = ar === undefined ? id : nameOf(ar, locale);
            return <Chip key={id} label={name} icon="close" selected accessibilitySelected={false} accessibilityLabel={t("storesDir.filter.remove", { name })} onPress={() => setLocation({ governorateId: location.governorateId, areaIds: location.areaIds.filter((x) => x !== id) })} testID={`stores-applied-${id}`} />;
          })}
          <Chip label={t("storesDir.filter.clearAll")} onPress={clearLocation} testID="stores-applied-clear" />
        </ScrollView>
      ) : null}
      <View style={{ flex: 1 }}>{body}</View>
      {chrome.locationSheet ? (
        <LocationSheet visible={sheet} onClose={() => setSheet(false)} selection={location} onChange={setLocation} counts={counts} resultCount={rows.length}
          locale={locale} t={(k, o) => (o === undefined ? t(k) : t(k, o))} num={num} />
      ) : null}
    </View>
  );
}
