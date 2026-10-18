import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Image, View, useWindowDimensions } from "react-native";
import { pluralKey } from "../../i18n/plural";
import { FabricBackdrop } from "../../components/FabricBackdrop";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, EmptyState, ErrorState, IconButton, PressScale, PriceBlock, Scrim, SearchField, Skeleton, Text, useTheme, CollapseOnScroll, useScrollCollapse } from "../../ui";
import { HeroArt, Illustration } from "../../art";
import type { HeroVariant } from "../../art/art-geometry";
import { getFeaturePorts } from "../../state/ports";
import { useServices } from "../../state/services";
import { useImpressionTracking } from "../analytics-ingest";
import { searchFailure, type SearchItem, type SearchPort } from "../search/model";
import { toTile } from "../search/SearchScreen";
import { productImage, useFormat, useOpenProduct } from "../home/parts";
import { claimOf } from "../home/model";
import { remainingNow } from "../budget/model";
import type { StoreSummary, WorldsPort } from "../worlds/model";
import type { Density } from "../grid-density";
import { DensityProductCard, GridDensityToggle, PinchToDensity, anchorIndexAfterChange, useGridDensity } from "../grid-density";
import { AppliedChips } from "../filters/AppliedChips";
import { FilterButton } from "../filters/FilterButton";
import { FilterSheet } from "../filters/FilterSheet";
import { chipFilterKey, removeChip, toSearchFilter, valueCount, changedKeys, type AppliedChip, type FilterEvent, type ListingFilters, type ListingRouteParams } from "../filters/model";
import { BoardCard, DEV_GRID, DEV_HERO } from "./BoardParts";
import {
  EMPTY_LISTING, emptyActions, hasListingParams, listingBadge, normalizeRoute, paramsPatch, parseListing, requestKey, resetFilters, sameListing, storesChanged,
  type ListingEmptyAction, type ListingState,
} from "./listing-model";
import {
  SELECTION_KEY, cellPadding, decodeSelection, encodeSelection, gridGap, isCategoryLayout, listKey, mergePages, pruneSelection, resultsCount, sortItems,
  categoryName, type CategoryNode, type CategoryPort,
} from "./model";

const DEPT_HERO: Readonly<Record<string, HeroVariant>> = { women: "atelier", men: "tide", kids: "drop", accessories: "ramadan" };
const PAGE_PAD = 20;

type Phase = { kind: "loading" } | { kind: "error"; offline: boolean } | { kind: "ready" };

/**
 * Shop all. Every filter (sort included) lives in the shared FilterSheet behind the single filter icon; the only filter UI on the screen is that icon,
 * the applied chips and a Reset. Route params round-trip: `/shop-all?store=a,b&category=…&min=…&sort=…&q=…`.
 */
export function ShopAllScreen(props: {
  port?: SearchPort; worlds?: WorldsPort; categories?: CategoryPort; initialParams?: ListingRouteParams;
}) {
  const f = useFormat();
  const { t } = f;
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const services = useServices();
  const open = useOpenProduct();
  const port = useMemo<SearchPort>(() => props.port ?? getFeaturePorts().search, [props.port]);
  const worlds = useMemo<WorldsPort>(() => props.worlds ?? getFeaturePorts().worlds, [props.worlds]);
  const categoryPort = useMemo<CategoryPort>(() => props.categories ?? getFeaturePorts().categories, [props.categories]);

  const params = useMemo(() => normalizeRoute(props.initialParams ?? {}), [props.initialParams]);
  const paramsKey = JSON.stringify(params);

  const [listing, setListing] = useState<ListingState>(EMPTY_LISTING);
  const listingRef = useRef<ListingState>(EMPTY_LISTING);
  listingRef.current = listing;
  const [tree, setTree] = useState<readonly CategoryNode[]>([]);
  const [treeReady, setTreeReady] = useState(false);
  const [treeFailed, setTreeFailed] = useState(false);
  const treeRef = useRef<readonly CategoryNode[]>([]);
  const [text, setText] = useState("");
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [stores, setStores] = useState<readonly StoreSummary[]>([]);
  const [storesFailed, setStoresFailed] = useState(false);
  const [items, setItems] = useState<readonly SearchItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [moreFailed, setMoreFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Budget context is read on this device only: it feeds the request-time price ceiling and never reaches a route, storage or analytics.
  const [signedIn, setSignedIn] = useState(false);
  const [budgetReady, setBudgetReady] = useState(false);
  const remainingRef = useRef<bigint | null>(null);
  const [remaining, setRemaining] = useState<bigint | null>(null);
  const lastWritten = useRef<string | null>(null);
  const grid = useGridDensity();
  const density = grid.density;
  const listRef = useRef<FlashListRef<SearchItem> | null>(null);
  // Viewability-based impressions (inert unless ingest is configured, consented and unblocked). Sponsored rows are server-counted ads.
  const impressions = useImpressionTracking<SearchItem>("feed", (i, index) => (i.storeId === undefined || i.sponsored ? null : { productId: i.id, storeId: i.storeId, position: index }));
  const collapse = useScrollCollapse();
  const firstVisibleId = useRef<string | null>(null);
  const seq = useRef(0);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const wishlists = useMemo(() => getFeaturePorts().wishlists, []);
  const save = (item: SearchItem): void => {
    if (saved.has(item.id)) return;
    setSaved((cur) => new Set(cur).add(item.id));
    wishlists.saveItem(item.id, "want", { title: item.title, price: item.price }).catch(() => {
      setSaved((cur) => { const n = new Set(cur); n.delete(item.id); return n; });
    });
  };
  const track = useCallback((fn: () => Promise<boolean>): void => { void fn().catch(() => undefined); }, []);

  useEffect(() => {
    void (async () => {
      let loaded: readonly CategoryNode[] = [];
      try { loaded = await categoryPort.tree(); } catch { setTreeFailed(true); }
      treeRef.current = loaded;
      setTree(loaded);
      setTreeReady(true);
    })();
  }, [categoryPort]);

  // Budget availability: signed in, consent granted, a monthly budget set. Anything missing leaves the Budget row in "set up" mode or hidden.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if ((await services.tokens.load()) === null || !live) return;
        setSignedIn(true);
        const budget = getFeaturePorts().budget;
        if (!(await budget.consent()) || !live) return;
        const r = remainingNow(await budget.summary(), false);
        if (r === null || !live) return;
        remainingRef.current = r.display;
        setRemaining(r.display);
        setBudgetReady(true);
      } catch { /* budget stays unavailable */ }
    })();
    return () => { live = false; };
  }, [services]);

  // Hydrate from the route; a plain route falls back to the saved per-device store selection. A route this screen wrote itself is not re-read.
  useEffect(() => {
    if (!treeReady) return;
    if (lastWritten.current === paramsKey) return;
    let live = true;
    void (async () => {
      let next: ListingState;
      if (hasListingParams(params)) {
        next = parseListing(params, treeRef.current);
      } else {
        const ids = await services.storage.getString(SELECTION_KEY).then(decodeSelection, (): readonly string[] => []);
        next = { filters: { ...EMPTY_LISTING.filters, storeIds: ids }, q: "" };
      }
      if (!live) return;
      setListing((cur) => (sameListing(cur, next) && hydrated ? cur : { filters: { ...next.filters, fitsBudget: cur.filters.fitsBudget }, q: next.q }));
      setText(next.q);
      setHydrated(true);
    })();
    return () => { live = false; };
  }, [treeReady, paramsKey, params, services, hydrated]);

  useEffect(() => {
    worlds.listStores().then((s) => { setStores(s); setStoresFailed(false); }, () => setStoresFailed(true));
  }, [worlds]);
  // Drop saved stores that no longer exist or were suspended (once both are known). Not written back as a user choice.
  useEffect(() => {
    if (!hydrated || stores.length === 0) return;
    const pruned = pruneSelection(listingRef.current.filters.storeIds, stores);
    if (pruned.length !== listingRef.current.filters.storeIds.length) setListing((cur) => ({ ...cur, filters: { ...cur.filters, storeIds: pruned } }));
  }, [hydrated, stores]);

  /** A change made by the shopper: state, saved store selection (only when the stores changed) and route. */
  const commit = useCallback((next: ListingState): void => {
    const before = listingRef.current;
    setListing(next);
    if (storesChanged(before.filters, next.filters)) {
      void services.storage.setString(SELECTION_KEY, encodeSelection(next.filters.storeIds)).catch(() => undefined);
    }
    const patch = paramsPatch(next);
    lastWritten.current = JSON.stringify(normalizeRoute(patch));
    router.setParams(patch);
  }, [services, router]);

  // Debounce typing into the applied query; clearing or external changes flow back into the field.
  useEffect(() => { setText(listing.q); }, [listing.q]);
  useEffect(() => {
    if (text.trim() === listing.q) return undefined;
    const h = setTimeout(() => commit({ ...listingRef.current, q: text.trim() }), 400);
    return () => clearTimeout(h);
  }, [text, listing.q, commit]);

  const wireFilter = useCallback((l: ListingState) => toSearchFilter(l.filters, treeRef.current, { remainingBudget: remainingRef.current }), []);
  const load = useCallback(async () => {
    const id = ++seq.current;
    setPhase({ kind: "loading" });
    setMoreFailed(false);
    try {
      const page = await port.search(listingRef.current.q, wireFilter(listingRef.current), null);
      if (id !== seq.current) return;
      setItems(page.items);
      setTotal(page.totalEstimate);
      setCursor(page.nextCursor);
      setPhase({ kind: "ready" });
    } catch (e) {
      if (id === seq.current) setPhase({ kind: "error", offline: searchFailure(e).offline });
    }
  }, [port, wireFilter]);

  const key = requestKey(listing, remaining);
  useEffect(() => { if (hydrated) void load(); }, [hydrated, key, load]);

  const loadMore = async () => {
    if (cursor === null || loadingMore || phase.kind !== "ready") return;
    const id = seq.current;
    setLoadingMore(true);
    try {
      const page = await port.search(listingRef.current.q, wireFilter(listingRef.current), cursor);
      if (id !== seq.current) return;
      setItems((cur) => mergePages(cur, page.items));
      setCursor(page.nextCursor);
      setMoreFailed(false);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const filters = listing.filters;
  const shown = useMemo(() => sortItems(items, filters.sort), [items, filters.sort]);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const count = phase.kind === "ready" ? resultsCount(total) : null;
  const badge = listingBadge(listing);

  // Sheet: a count for the draft (server total_estimate only), analytics per applied key, and the apply itself.
  const countFor = useCallback(
    (draft: ListingFilters): Promise<number> => port.count(listingRef.current.q, toSearchFilter(draft, treeRef.current, { remainingBudget: remainingRef.current })),
    [port],
  );
  /** Footer N of the draft being applied (server total_estimate); filter_applied is only sent when it is known. */
  const sheetCount = useRef<number | null>(null);
  const onSheetEvent = (e: FilterEvent): void => {
    if (e.type === "opened") track(() => services.analytics.track("filter_sheet_opened", { surface: "shop_all" }));
    else if (e.type === "applied") sheetCount.current = e.resultCount;
    else if (e.type === "reset") track(() => services.analytics.track("filter_reset", { surface: "shop_all" }));
  };
  const onApply = (next: ListingFilters): void => {
    const n = sheetCount.current;
    if (n !== null) {
      for (const k of changedKeys(filters, next)) {
        track(() => services.analytics.track("filter_applied", { filter_key: k, value_count: valueCount(next, k), result_count: n, surface: "shop_all" }));
      }
    }
    commit({ ...listing, filters: next });
  };
  const onRemoveChip = (c: AppliedChip): void => {
    track(() => services.analytics.track("filter_chip_removed", { filter_key: chipFilterKey(c) }));
    commit({ ...listing, filters: removeChip(filters, c) });
  };
  const onResetAll = (): void => {
    track(() => services.analytics.track("filter_reset", { surface: "shop_all" }));
    commit(resetFilters(listing));
  };

  // Collection header: opened for exactly one store from the route.
  const routeStoreIds = params["store"] !== undefined ? params["store"].split(",") : [];
  const collectionStore = routeStoreIds.length === 1 && filters.storeIds.length === 1 && filters.storeIds[0] === routeStoreIds[0]
    ? stores.find((s) => s.id === routeStoreIds[0]) ?? null : null;
  const screenTitle = collectionStore !== null ? collectionStore.name : t("shopAll.title");
  const kindOf = useMemo(() => new Map(stores.map((s) => [s.id, s.kind] as const)), [stores]);
  const mixedScope = useMemo(() => new Set(shown.map((i) => (i.storeId !== undefined ? kindOf.get(i.storeId) : undefined)).filter((k) => k !== undefined)).size > 1, [shown, kindOf]);

  // The hero is a decorative header for department and category routes; it carries no filter control.
  const categoryLayout = isCategoryLayout(params, collectionStore !== null);
  const heroDepartment = filters.department;
  const heroCategory = filters.categoryIds.length === 1 ? tree.find((n) => n.id === filters.categoryIds[0]) : undefined;
  const heroTitle = heroDepartment !== null ? t(`home.dept.${heroDepartment}`) : heroCategory !== undefined ? categoryName(heroCategory, f.locale) : t("shopAll.title");

  const collectionMeta: string[] = [];
  if (collectionStore !== null) {
    collectionMeta.push(t(collectionStore.kind === "local" ? "worlds.local" : "worlds.global"));
    if (collectionStore.rating !== null) collectionMeta.push(t("worlds.rating", { value: f.num(collectionStore.rating) }));
    if (collectionStore.maxVerifiedDiscountPct !== null) collectionMeta.push(t("worlds.discountUpTo", { pct: f.num(collectionStore.maxVerifiedDiscountPct) }));
  }
  const collection = collectionStore !== null ? (
    <View style={{ gap: 4 }} testID="shop-all-collection">
      <Text variant="title1" accessibilityRole="header">{collectionStore.name}</Text>
      <Text variant="caption" secondary>{collectionMeta.join("  ·  ")}</Text>
    </View>
  ) : null;

  const searchRow = (
    <SearchField
      value={text}
      onChangeText={setText}
      onSubmit={() => commit({ ...listing, q: text.trim() })}
      placeholder={t("shopAll.searchPlaceholder")}
      label={t("shopFilter.searchLabel")}
      clearLabel={t("shopFilter.clearQuery")}
      testID="shop-all-search"
    />
  );

  const changeDensity = useCallback((next: Density): void => {
    if (next === density) return;
    const anchor = anchorIndexAfterChange(shown, firstVisibleId.current);
    grid.setDensity(next);
    // The list remounts on a column change; restore the first visible item on the next frame (device spike).
    requestAnimationFrame(() => {
      if (anchor > 0) listRef.current?.scrollToIndex({ index: anchor, animated: false });
    });
  }, [density, grid, shown]);

  const countText = count !== null ? t(pluralKey("shopAll.productCount", count), { n: f.num(count) }) : null;
  // Screen readers get the new result count once filters settle (iOS ignores live regions).
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (countText === null) return undefined;
    const previous = announced.current;
    announced.current = countText;
    if (previous === null || previous === countText) return undefined;
    const h = setTimeout(() => AccessibilityInfo.announceForAccessibility(countText), 500);
    return () => clearTimeout(h);
  }, [countText]);

  // The one filter icon, the live count (from the API only), Reset and the density toggle.
  const controlRow = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
      <FilterButton count={badge} onPress={() => setSheet(true)} testID="shop-all-filter-button" />
      {count !== null ? <Text variant="caption" secondary testID="shop-all-count" style={{ flexShrink: 1 }}>{countText}</Text> : null}
      <View style={{ flex: 1 }} />
      {badge > 0 ? (
        <PressScale accessibilityRole="button" accessibilityLabel={t("shopFilter.clearAll")} onPress={onResetAll} innerStyle={{ minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 4 }} testID="shop-all-reset">
          <Text variant="caption" weight="600" accessibilityRole="none">{t("shopFilter.clearAll")}</Text>
        </PressScale>
      ) : null}
      <GridDensityToggle density={density} onChange={changeDensity} testID="shop-all-density" />
    </View>
  );

  const topControls = (
    <View style={{ gap: 6, paddingBottom: 4 }}>
      {collection}
      {controlRow}
      <AppliedChips filters={filters} tree={tree} stores={stores} onRemove={onRemoveChip} testID="shop-all-applied" />
      {storesFailed ? <Text variant="caption" secondary>{t("shopAll.storesUnavailable")}</Text> : null}
    </View>
  );

  const renderCard = (item: SearchItem, index: number) => {
    const p = toTile(item);
    const c = claimOf(p);
    const kind = item.storeId !== undefined ? kindOf.get(item.storeId) : undefined;
    const scopeTag = mixedScope && kind !== undefined ? t(kind === "local" ? "worlds.local" : "worlds.global") : null;
    const storeLine = scopeTag !== null ? `${p.storeName}  ·  ${scopeTag}` : p.storeName;
    const devPhoto = DEV_GRID !== null ? DEV_GRID[((index % DEV_GRID.length) + DEV_GRID.length) % DEV_GRID.length] : undefined;
    if (density <= 2) {
      return (
        <BoardCard
          image={devPhoto !== undefined ? <Image source={devPhoto} resizeMode="cover" style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors /> : productImage(p)}
          pillText={c !== null ? `-${f.num(c.percent)}%` : null}
          brand={p.storeName} name={p.title} priceText={f.money(p.price)} referenceText={c !== null ? f.money(c.referencePrice) : null}
          saved={saved.has(item.id)} onToggleSave={() => save(item)} saveLabel={t("shopAll.saveItem", { name: p.title })}
          onPress={() => open(p.id)} accessibilityLabel={`${p.title}, ${p.storeName}, ${f.money(p.price)}`} testID={`shop-all-item-${item.id}`}
        />
      );
    }
    return (
      <DensityProductCard
        density={density}
        imageNode={productImage(p)}
        storeLabel={p.storeName.length > 0 ? storeLine : undefined}
        name={p.title}
        priceNode={(
          <PriceBlock
            priceText={f.money(p.price)}
            priceMinor={p.price}
            launchLabel={t("pdp.launchPrice")}
            {...(c !== null ? { claim: { referenceMinor: c.referencePrice, percent: c.percent, verified: true, referenceText: f.money(c.referencePrice), percentText: f.pct(c.percent) } } : {})}
          />
        )}
        heart={{ saved: saved.has(item.id), onToggle: () => save(item), accessibilityLabel: t("shopAll.saveItem", { name: p.title }) }}
        onPress={() => open(p.id)}
        accessibilityLabel={`${p.title}, ${p.storeName}, ${f.money(p.price)}`}
        testID={`shop-all-item-${item.id}`}
      />
    );
  };

  const listShown = hydrated && phase.kind === "ready" && shown.length > 0;
  useEffect(() => { collapse.reset(); }, [collapse, density, listShown]);

  let body;
  if (!hydrated || phase.kind === "loading") {
    body = (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={t("common.loading")} style={{ gap: 20 }}>
        {[0, 1].map((r) => (
          <View key={r} style={{ flexDirection: "row", gap: 14 }}>
            {[0, 1].map((k) => <View key={k} style={{ flex: 1, gap: 8 }}><Skeleton height={230} radius={18} /><Skeleton width="70%" height={12} /></View>)}
          </View>
        ))}
      </View>
    );
  } else if (phase.kind === "error") {
    body = <ErrorState offline={phase.offline} title={t(phase.offline ? "shopAll.offlineTitle" : "shopAll.errorTitle")} description={t(phase.offline ? "shopAll.offlineBody" : "shopAll.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />;
  } else if (shown.length === 0) {
    const actions = emptyActions(listing);
    const budgetBound = filters.priceMax !== null;
    const anyFilter = badge > 0 || listing.q.length > 0;
    const run = (a: ListingEmptyAction): void => commit(a === "resetFilters" ? resetFilters(listing) : { ...listing, q: "" });
    body = (
      <View>
        <EmptyState
          illustration={<Illustration name="noResults" size={120} />}
          title={t(budgetBound ? "shopFilter.emptyBudgetTitle" : anyFilter ? "shopFilter.emptyFiltersTitle" : "shopAll.emptyAllTitle")}
          description={t(budgetBound ? "shopFilter.emptyBudgetBody" : anyFilter ? "shopFilter.emptyFiltersBody" : "shopAll.emptyAllBody")}
        />
        {actions.length > 0 ? (
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {actions.map((a) => <Chip key={a} label={t(a === "resetFilters" ? "shopFilter.clearAll" : "shopFilter.clearQuery")} onPress={() => run(a)} testID={`shop-all-empty-${a}`} />)}
          </View>
        ) : null}
      </View>
    );
  } else {
    body = (
      <PinchToDensity density={density} max={grid.allowed[grid.allowed.length - 1]} onChange={changeDensity} style={{ flex: 1 }}>
        <FlashList
          key={listKey(density)}
          ref={listRef}
          data={shown}
          numColumns={density}
          keyExtractor={(i) => i.id}
          extraData={saved}
          onScroll={collapse.onScroll}
          onContentSizeChange={collapse.onContentSizeChange}
          onLayout={collapse.onLayout}
          scrollEventThrottle={16}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.6}
          viewabilityConfig={impressions.viewabilityConfig}
          onViewableItemsChanged={({ viewableItems }) => {
            impressions.onViewableItemsChanged({ viewableItems });
            const first = viewableItems.find((v) => v.isViewable && v.item !== undefined);
            if (first !== undefined) firstVisibleId.current = (first.item as SearchItem).id;
          }}
          renderItem={({ item, index }) => {
            const pad = cellPadding(index, density, gridGap(density));
            /* physical-direction: FlashList lays columns out left to right in RTL too */
            return <View style={{ paddingBottom: density >= 3 ? 14 : 24, paddingLeft: pad.left, paddingRight: pad.right }}>{renderCard(item, index)}</View>;
          }}
          ListFooterComponent={
            loadingMore ? <Text variant="caption" secondary>{t("shopAll.loadingMore")}</Text>
            : moreFailed ? <Chip label={t("shopAll.loadMoreFailed")} onPress={() => void loadMore()} testID="shop-all-retry-more" /> : null
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        />
      </PinchToDensity>
    );
  }

  const heroHeight = Math.round(winH * 0.3);
  const heroTop = (
    <View style={{ height: heroHeight, marginBottom: 12 }} testID="shop-all-hero">
      <View style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }}>
        {DEV_HERO !== null ? <Image source={DEV_HERO} resizeMode="cover" blurRadius={2} style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors />
          : <HeroArt variant={DEPT_HERO[heroDepartment ?? ""] ?? "atelier"} aspect={1.6} style={{ height: "100%" }} />}
      </View>
      <Scrim position="bottom" />
      <View style={{ position: "absolute", top: insets.top + 4, start: 12, end: 12, flexDirection: "row", justifyContent: "space-between" }}>
        <IconButton variant="glass" color="onImage" icon="chevron-back" directional label={t("common.back")} onPress={back} testID="shop-all-back" />
        <View style={{ flexDirection: "row", gap: 4 }}>
          <IconButton variant="glass" color="onImage" icon="search-outline" label={t("shopFilter.searchLabel")} onPress={() => router.push("/search")} testID="shop-all-hero-search" />
          <IconButton variant="glass" color="onImage" icon="bag-handle-outline" label={t("tabs.bag")} onPress={() => router.push("/bag")} testID="shop-all-hero-bag" />
        </View>
      </View>
      <View style={{ position: "absolute", bottom: 16, start: PAGE_PAD, end: PAGE_PAD, gap: 2 }}>
        <Text variant="display" color="onImage" accessibilityRole="header">{heroTitle}</Text>
        <Text variant="callout" color="onImage">{t("shopAll.categoryTagline")}</Text>
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }} testID="shop-all-screen">
      <FabricBackdrop soft />
      {categoryLayout ? heroTop : (
        <View style={{ flexDirection: "row", alignItems: "center", paddingTop: insets.top + 8, paddingHorizontal: PAGE_PAD - 8, paddingBottom: 8 }}>
          <IconButton variant="solid" icon="chevron-back" directional label={t("common.back")} onPress={back} testID="shop-all-back" />
          <Text variant="quote" weight="400" accessibilityRole="header" numberOfLines={1} align="center" style={{ flex: 1 }}>{screenTitle}</Text>
          <View style={{ width: 44 }} />
        </View>
      )}
      <View style={{ flex: 1, paddingHorizontal: PAGE_PAD }}>
        {categoryLayout ? null : <View style={{ paddingBottom: 6 }}>{searchRow}</View>}
        <CollapseOnScroll scroll={collapse}>{topControls}</CollapseOnScroll>
        <View style={{ flex: 1 }}>{body}</View>
      </View>

      <FilterSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        filters={filters}
        onApply={onApply}
        tree={tree}
        treeFailed={treeFailed}
        stores={stores}
        signedIn={signedIn}
        budgetReady={budgetReady}
        onSetupBudget={() => router.push("/budget")}
        countFor={countFor}
        onEvent={onSheetEvent}
      />
    </View>
  );
}
