import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { ErrorState, Icon, IconButton, PressScale, Screen, Skeleton, Text, useTheme } from "../../ui";
import { brand, radius, spacing } from "@outlet/ui-tokens";
import { MenuGlyph } from "../../components/MenuGlyph";
import { Wordmark } from "../../art";
import { getFeaturePorts } from "../../state/ports";
import { AnalyticsBanner } from "../first-launch/AnalyticsBanner";
import { WORLDS, buildDirectory, worldAfterWiden, type StoreSummary, type WorldsPort } from "../worlds/model";
import { useWorld } from "../worlds/useWorld";
import {
  buildHome, scopeProducts, departmentTap, homeFailure, homeReasonKey, inferKind, shouldTrackSection, upcomingDrops,
  type Department, type HeroDrop, type HomePort, type HomeProduct, type HomeReasonSection, type HomeState,
} from "./model";
import { homeStoreRows, type CategoryNode, type CategoryPort } from "../shop-all/model";
import { AppliedChips } from "../filters/AppliedChips";
import { FilterButton } from "../filters/FilterButton";
import { FilterSheet } from "../filters/FilterSheet";
import { EMPTY_LISTING_FILTERS, badgeCount, isEmptyListing, listingReducer, toRouteParams, toSearchFilter } from "../filters/model";
import { CategoryWindow } from "../category-window/CategoryWindow";
import { loadCategoryCounts } from "../category-window/api";
import type { CategoryCounts } from "../category-window/model";
import { useOptionalServices } from "../../state/services";
import type { SearchPort } from "../search/model";
import { StoreListRow } from "./banner";
import { DepartmentGrid } from "./sections";
import { OffersCarousel } from "../home-banners/OffersCarousel";
import { QuickActions } from "../home-banners/QuickActions";
import { PromoBanners } from "../home-banners/PromoBanners";
import type { HomeBannersData, HomeBannersPort } from "../home-banners/model";
import { useServerClock } from "./useServerCountdown";
import { GridSkeleton, ProductGrid, ProductTile, Rail, SectionTitle, WorldEmpty, useFormat, useOpenProduct } from "./parts";
import { pluralKey } from "../../i18n/plural";

export function HomeScreen(props: { port?: HomePort; worlds?: WorldsPort; banners?: HomeBannersPort; search?: SearchPort; categories?: CategoryPort }) {
  const f = useFormat();
  const { t } = f;
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const open = useOpenProduct();
  const port = useMemo<HomePort>(() => props.port ?? getFeaturePorts().home, [props.port]);
  const w = useWorld(props.worlds);
  const [state, setState] = useState<HomeState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const bannersPort = useMemo<HomeBannersPort>(() => props.banners ?? getFeaturePorts().homeBanners, [props.banners]);
  const [offers, setOffers] = useState<HomeBannersData | null>(null);
  const loadOffers = useCallback(async () => {
    try { setOffers(await bannersPort.load()); } catch { setOffers(null); }
  }, [bannersPort]);
  useEffect(() => { void loadOffers(); }, [loadOffers]);

  const heroBanners = useMemo(() => {
    const all = offers?.banners ?? [];
    const plain = all.filter((b) => !b.sponsored);
    return plain.length > 0 ? plain : all;
  }, [offers]);
  const promoBanners = useMemo(() => {
    const all = offers?.banners ?? [];
    return all.some((b) => !b.sponsored) ? all.filter((b) => b.sponsored) : [];
  }, [offers]);

  const featurePorts = getFeaturePorts();
  const [bagCount, setBagCount] = useState(0);
  useFocusEffect(useCallback(() => {
    let alive = true;
    featurePorts.bag.load().then((snap) => {
      if (alive) setBagCount(snap.lines.reduce((n, l) => (l.savedForLater || l.availability !== "available" ? n : n + l.qty), 0));
    }).catch(() => { if (alive) setBagCount(0); });
    return () => { alive = false; };
  }, [featurePorts.bag]));
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
  const saving = useRef(false);
  const saveProduct = useCallback((p: HomeProduct) => {
    if (saving.current || savedIds.has(p.id)) return;
    saving.current = true;
    featurePorts.wishlists.saveItem(p.id, "want", { title: p.title, price: p.price })
      .then(() => setSavedIds((cur) => new Set(cur).add(p.id)))
      .catch(() => undefined)
      .finally(() => { saving.current = false; });
  }, [featurePorts.wishlists, savedIds]);

  const searchPort = useMemo<SearchPort>(() => props.search ?? getFeaturePorts().search, [props.search]);
  const categoryPort = useMemo<CategoryPort>(() => props.categories ?? getFeaturePorts().categories, [props.categories]);
  const [tree, setTree] = useState<readonly CategoryNode[]>([]);
  const [treeFailed, setTreeFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    categoryPort.tree().then((t) => { if (alive) setTree(t); }).catch(() => { if (alive) setTreeFailed(true); });
    return () => { alive = false; };
  }, [categoryPort]);
  // Filters live in memory only: the price range is never persisted or logged.
  const [filters, dispatchFilters] = useReducer(listingReducer, EMPTY_LISTING_FILTERS);
  const [filterSheet, setFilterSheet] = useState(false);
  const serverFiltered = !isEmptyListing(filters);
  const [filtered, setFiltered] = useState<{ status: "idle" | "loading" | "error" | "ready"; items: readonly HomeProduct[] }>({ status: "idle", items: [] });
  useEffect(() => {
    if (!serverFiltered) { setFiltered({ status: "idle", items: [] }); return; }
    let alive = true;
    setFiltered({ status: "loading", items: [] });
    searchPort.search("", toSearchFilter(filters, tree), null).then((page) => {
      if (!alive) return;
      const now = Date.now();
      const items = page.items.map((it, i): HomeProduct => ({
        id: it.id, title: it.title, storeId: it.storeId ?? "", storeName: it.storeName, kind: inferKind(it.title), price: it.price,
        referencePrice: it.verifiedDiscountPct !== null ? it.referencePrice ?? null : null, verifiedPct: it.verifiedDiscountPct,
        isLaunchPrice: false, createdAtMs: now - i, endsAtMs: null, sponsored: it.sponsored,
      }));
      setFiltered({ status: "ready", items });
    }).catch(() => { if (alive) setFiltered({ status: "error", items: [] }); });
    return () => { alive = false; };
  }, [serverFiltered, filters, tree, searchPort]);

  // Category window (round-2 item 2). Counts only if the server sends them.
  const [windowNode, setWindowNode] = useState<CategoryNode | null>(null);
  const [counts, setCounts] = useState<CategoryCounts | undefined>(undefined);
  useEffect(() => {
    if (windowNode === null) return undefined;
    let alive = true;
    void loadCategoryCounts(searchPort, {}).then((c) => { if (alive) setCounts(c); }).catch(() => undefined);
    return () => { alive = false; };
  }, [windowNode, searchPort]);
  const retryTree = useCallback(() => {
    setTreeFailed(false);
    categoryPort.tree().then((t) => setTree(t)).catch(() => setTreeFailed(true));
  }, [categoryPort]);

  // Consent-aware section analytics: ClientAnalytics.track resolves false until `analytics` consent is granted.
  const analytics = useOptionalServices()?.analytics ?? null;
  const seenSections = useRef<Set<HomeReasonSection>>(new Set());
  const sectionViewed = useCallback((section: HomeReasonSection) => {
    if (analytics === null || !shouldTrackSection(seenSections.current, section)) return;
    void analytics.track("home_section_viewed", { section }).catch(() => false);
  }, [analytics]);
  const sectionSeeAll = useCallback((section: HomeReasonSection) => {
    void analytics?.track("home_section_see_all", { section }).catch(() => false);
  }, [analytics]);

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", data: await port.load() });
    } catch (e) {
      setState(homeFailure(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const clock = useServerClock(state.status === "ready" ? state.data.serverNowMs : null);
  const serverNow = clock.atLoadMs;
  const stores: readonly StoreSummary[] = w.state.status === "ready" ? w.state.stores : [];
  const dir = useMemo(() => buildDirectory(stores, w.world, w.sort), [stores, w.world, w.sort]);
  const view = useMemo(
    () => (state.status === "ready" && serverNow !== null ? buildHome(state.data, stores, w.world, serverNow) : null),
    [state, stores, w.world, serverNow],
  );
  const drops = useMemo<readonly HeroDrop[]>(() => {
    if (state.status !== "ready" || serverNow === null) return [];
    const order = upcomingDrops(state.data, serverNow).map((b) => b.id);
    const src = state.data.drops ?? (state.data.hero !== null ? [state.data.hero] : []);
    return order.flatMap((id) => { const d = src.find((x) => x.id === id); return d === undefined ? [] : [d]; });
  }, [state, serverNow]);
  const homeRows = useMemo(() => homeStoreRows(dir.rows), [dir.rows]);
  const myStoresEmpty = w.world === "myStores" && dir.empty !== null;

  const onRefresh = () => {
    setRefreshing(true);
    void Promise.all([load(), w.reload(), loadOffers()]).finally(() => setRefreshing(false));
  };
  const widen = () => w.setWorld(worldAfterWiden());
  const toExplore = useCallback(() => router.push("/explore"), [router]);
  const toShopAll = useCallback(() => router.push("/shop-all"), [router]);
  const toStores = useCallback(() => router.push("/stores"), [router]);
  const openDrop = useCallback((id: string) => router.push({ pathname: "/drops", params: { id } }), [router]);
  const openDept = useCallback((d: Department) => {
    const tap = departmentTap(tree, d);
    if (tap.kind === "window") { setCounts(undefined); setWindowNode(tap.node); return; }
    const target = tap.target;
    router.push({ pathname: "/shop-all", params: { ...(target.department !== undefined ? { department: target.department } : {}), ...(target.category !== undefined ? { category: target.category } : {}), ...(target.q !== undefined ? { q: target.q } : {}) } });
  }, [tree, router]);
  const onWindowSelect = useCallback((target: CategoryNode, row: "all" | "child", hasCount: boolean) => {
    void analytics?.track("category_window_selected", { category_id: target.id, has_count: hasCount }).catch(() => false);
    setWindowNode(null);
    router.push({ pathname: "/shop-all", params: { category: target.id } });
  }, [analytics, router]);
  const worldSection = useMemo(() => ({
    value: w.world, defaultValue: "everything", options: WORLDS as readonly string[],
    label: (x: string) => t(`home.worldShort.${x}`), onChange: (x: string) => { const next = WORLDS.find((o) => o === x); if (next !== undefined) w.setWorld(next); },
  }), [t, w.world, w.setWorld]);
  const filterCount = badgeCount(filters) + (w.world === "everything" ? 0 : 1);
  const clearWorld = () => w.setWorld("everything");
  const toShopAllFiltered = () => router.push({ pathname: "/shop-all", params: { ...toRouteParams(filters) } });
  const seeAllStores = () => { sectionSeeAll("stores"); toStores(); };
  const storesReason = homeReasonKey("stores", null);
  const allReason = homeReasonKey("all_pieces", null);
  const openStore = (id: string) => router.push({ pathname: "/shop-all", params: { store: id } });

    const onHero = heroBanners.length > 0;
    const headerEl = (
          <View style={{ paddingHorizontal: 12, minHeight: 44, flexDirection: "row", alignItems: "center", ...(onHero ? { position: "absolute" as const, top: insets.top, start: 0, end: 0, zIndex: 2 } : {}) }} testID="home-header">
            <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-start" }}>
              <PressScale onPress={toExplore} accessibilityRole="button" accessibilityLabel={t("homeBanners.menuLabel")} testID="home-menu" scale={0.92} innerStyle={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                <MenuGlyph color={onHero ? brand.ivory : colors.textPrimary} size={24} />
              </PressScale>
            </View>
            <Wordmark size={18} {...(onHero ? { tone: "dark" as const } : {})} />
            <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end" }}>
              <IconButton icon="search-outline" label={t("home.searchLabel")} onPress={() => router.push("/search")} testID="home-search" {...(onHero ? { color: "onImage" as const } : {})} />
              <View>
                <IconButton
                  icon="bag-handle-outline"
                  label={bagCount > 0 ? t(pluralKey("home.bagLabelCount", bagCount), { count: f.num(bagCount) }) : t("home.bagLabel")}
                  onPress={() => router.push("/bag")}
                  testID="home-bag"
                  {...(onHero ? { color: "onImage" as const } : {})}
                />
                {bagCount > 0 ? (
                  <View pointerEvents="none" style={{ position: "absolute", top: 4, end: 4, minWidth: 18, height: 18, borderRadius: radius.pill, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}>
                    <Text variant="caption" weight="600" color="onAccent" numeric accessibilityRole="none" maxScale={1.2}>{f.num(bagCount)}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
    );
    return (
    <View style={{ flex: 1 }}>
      <Screen padded={false} statusScrim={!onHero} onRefresh={onRefresh} refreshing={refreshing} contentStyle={{ gap: onHero ? 0 : 20 }}>
        {onHero ? (
          // Hero runs under the transparent header and under the status area (cancels Screen's top padding).
          <View style={{ marginTop: -(insets.top + 16) }}>
            <OffersCarousel devFixtures={offers?.devFixtures} banners={heroBanners} serverNowMs={offers?.serverNowMs ?? Date.now()} topInset={insets.top + 16} />
            {headerEl}
          </View>
        ) : headerEl}
        {/* Sheet overlapping the hero's bottom edge with a rounded top */}
        <View style={{ gap: 16, marginTop: onHero ? -radius.xl : 0, paddingTop: onHero ? 16 : 0, borderTopStartRadius: radius.xl, borderTopEndRadius: radius.xl, backgroundColor: colors.background }}>
        {/* First-launch analytics consent: inline card under the hero, above the quick actions. Disappears only by answering. */}
        <View style={{ paddingHorizontal: spacing.lg }}><AnalyticsBanner /></View>
        {/* (2) Glass quick actions */}
        <QuickActions onViewStores={seeAllStores} onShopEverything={toShopAll} />
        {/* (3) Promotions (distinct from the hero) and upcoming drops */}
        <PromoBanners banners={promoBanners} drops={drops} nowFn={clock.nowFn} onOpenDrop={openDrop} devFixtures={offers?.devFixtures} />
        {/* (4) Shop by category */}
        <View style={{ gap: 4, marginTop: -8 }}>
          {/* The single filter icon sits in the section header, next to "See all" */}
          <SectionTitle title={t("home.shopByCategory")} action={{ label: t("home.seeAll"), onPress: toShopAll }} trailing={<FilterButton count={filterCount} onPress={() => setFilterSheet(true)} testID="home-filter-button" />} />
          <DepartmentGrid onOpen={openDept} devFixtures={offers?.devFixtures} />
        </View>
        {/* Applied filters show as chips; the row only exists while something is applied */}
        {filterCount > 0 || w.world !== "everything" ? (
          <View style={{ paddingHorizontal: 16 }} testID="home-filter-row">
            <AppliedChips filters={filters} tree={tree} stores={stores} onRemove={(c) => dispatchFilters({ type: "removeChip", chip: c })} world={{ active: w.world !== "everything", label: t(`home.worldShort.${w.world}`), onClear: clearWorld }} testID="home-applied-chips" />
          </View>
        ) : null}

        {state.status === "error" ? (
          <ErrorState offline={state.offline} title={t(state.offline ? "home.offlineTitle" : "home.errorTitle")} description={t(state.offline ? "home.offlineBody" : "home.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
        ) : null}

        {state.status === "loading" ? <GridSkeleton /> : null}

        {view !== null ? (
          <View style={{ gap: 24 }}>
            {dir.hiddenFavouriteCount > 0 ? (
              <View style={{ paddingHorizontal: 16 }}><Text variant="caption" secondary>{t("worlds.hiddenFavourites", { count: f.num(dir.hiddenFavouriteCount) })}</Text></View>
            ) : null}
            {myStoresEmpty && dir.empty !== null ? <WorldEmpty kind={dir.empty} onWiden={dir.canWiden ? widen : undefined} /> : null}
            {!myStoresEmpty && view.empty ? <WorldEmpty kind="noStores" /> : null}
            {serverFiltered ? (
              filtered.status === "loading" ? <View style={{ paddingHorizontal: 16 }}><Skeleton height={220} radius={18} /></View>
              : filtered.status === "error" ? <View style={{ paddingHorizontal: 16 }}><Text variant="caption" secondary>{t("home.filterFailed")}</Text></View>
              : filtered.items.length === 0 ? <View style={{ paddingHorizontal: 16 }}><Text variant="body" secondary testID="home-filter-empty">{t("home.filterEmpty")}</Text></View>
              : (
                <Rail itemWidth={148} title={t("home.justDropped")} action={{ label: t("home.seeAll"), onPress: toShopAllFiltered }}>
                  {(w.world === "everything" ? filtered.items : scopeProducts(filtered.items, stores, w.world)).slice(0, 8).map((p) => <ProductTile key={p.id} product={p} width={148} onOpen={open} saved={savedIds.has(p.id)} onSave={saveProduct} />)}
                </Rail>
              )
            ) : view.newDrops.length > 0 ? (
              <Rail itemWidth={148} title={t("home.justDropped")} action={{ label: t("home.seeAll"), onPress: toExplore }}>
                {view.newDrops.map((p) => <ProductTile key={p.id} product={p} width={148} onOpen={open} saved={savedIds.has(p.id)} onSave={saveProduct} />)}
              </Rail>
            ) : null}
            {view.verified.length > 0 ? (
              <Rail itemWidth={148} title={t("home.railVerified")}>
                {view.verified.map((p) => <ProductTile key={p.id} product={p} width={148} onOpen={open} saved={savedIds.has(p.id)} onSave={saveProduct} />)}
              </Rail>
            ) : null}
            {view.forYou !== null ? (
              <Rail itemWidth={148} title={t("home.railForYou")}>
                {view.forYou.map((p) => <ProductTile key={p.id} product={p} width={148} onOpen={open} saved={savedIds.has(p.id)} onSave={saveProduct} />)}
              </Rail>
            ) : null}
            {view.endingSoon.length > 0 ? (
              <Rail itemWidth={148} title={t("home.railEnding")}>
                {view.endingSoon.map((p) => <ProductTile key={p.id} product={p} width={148} onOpen={open} saved={savedIds.has(p.id)} onSave={saveProduct} />)}
              </Rail>
            ) : null}
            {homeRows.length > 0 ? (
              <View style={{ gap: 6 }} onLayout={() => sectionViewed("stores")} testID="home-stores-section">
                <SectionTitle title={t("shopAll.storesTitle")} reason={t(storesReason.key, storesReason.vars)}
                  action={{ label: t("homeReason.seeAll"), accessibilityLabel: t("homeReason.seeAllName", { section: t("shopAll.storesTitle") }), onPress: seeAllStores }} />
                <View style={{ paddingHorizontal: 16 }}>
                  {homeRows.map((st, i) => <StoreListRow key={st.id} store={st} index={i} onPress={() => openStore(st.id)} />)}
                  <PressScale onPress={seeAllStores} accessibilityRole="button" accessibilityLabel={t("shopAll.seeAllStores")} testID="home-see-all-stores"
                    innerStyle={{ minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Text variant="callout" weight="600" accessibilityRole="none">{t("shopAll.seeAllStores")}</Text>
                    <Icon name="chevron-forward" size={18} color="textSecondary" directional />
                  </PressScale>
                </View>
              </View>
            ) : null}
            {view.grid.length > 0 ? (
              <View style={{ gap: 8 }} onLayout={() => sectionViewed("all_pieces")} testID="home-all-pieces-section">
                <SectionTitle title={t("home.gridTitle")} reason={t(allReason.key, allReason.vars)}
                  action={{ label: t("homeReason.seeAll"), accessibilityLabel: t("homeReason.seeAllName", { section: t("home.gridTitle") }), onPress: () => { sectionSeeAll("all_pieces"); toShopAll(); } }} />
                <ProductGrid products={view.grid} onOpen={open} />
              </View>
            ) : null}
          </View>
        ) : null}
        </View>
      </Screen>
      <FilterSheet
        visible={filterSheet}
        onClose={() => setFilterSheet(false)}
        filters={filters}
        onApply={(next) => dispatchFilters({ type: "replace", filters: next })}
        tree={tree}
        treeFailed={treeFailed}
        stores={stores}
        signedIn={false}
        budgetReady={false}
        onSetupBudget={() => undefined}
        countFor={(draft) => searchPort.count("", toSearchFilter(draft, tree))}
        world={worldSection}
        testID="home-filter-sheet"
      />
      <CategoryWindow
        visible={windowNode !== null}
        onClose={() => setWindowNode(null)}
        node={windowNode}
        tree={tree}
        treeLoading={tree.length === 0 && !treeFailed}
        treeFailed={treeFailed}
        onRetry={retryTree}
        counts={counts}
        onSelect={onWindowSelect}
      />
    </View>
  );
}
