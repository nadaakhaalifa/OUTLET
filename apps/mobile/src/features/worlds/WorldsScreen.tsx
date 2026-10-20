import { useCallback, useEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, Icon, PressScale, Reveal, Screen, SectionHeader, Text, useTheme } from "../../ui";
import { ProductArt } from "../../art";
import { radius } from "@outlet/ui-tokens";
import { getFeaturePorts, getGuestStore } from "../../state/ports";
import { withGuestStore } from "../guest";
import { useGuestMode } from "../guest/useGuestMode";
import { useServices } from "../../state/services";
import { getApiRuntime, createAdapterContext } from "../../services/runtime";
import { CategoryWindow } from "../category-window/CategoryWindow";
import { loadCategoryCounts } from "../category-window/api";
import { opensDirectly, shopAllParams, type CategoryCounts } from "../category-window/model";
import { ApiDiscoverPort } from "../discover/api";
import { DiscoverModules } from "../discover/DiscoverModules";
import { EMPTY_DISCOVER, InMemoryDiscoverPort, discoverFailure, type DiscoverPort, type DiscoverScreenState } from "../discover/model";
import { FilterButton } from "../filters/FilterButton";
import { FilterSheet } from "../filters/FilterSheet";
import { EMPTY_LISTING_FILTERS, badgeCount, toRouteParams, type ListingFilters } from "../filters/model";
import { InlineSearch } from "../search/InlineSearch";
import type { SearchPort } from "../search/model";
import type { CategoryNode } from "../shop-all/model";
import {
  CATEGORY_TILES, DISCOVER_DEPARTMENTS, TILES_PER_ROW, TILES_PER_ROW_LARGE_TEXT, departmentParams, nodeForSlug, rowsOf, type StoreSummary,
} from "./model";

const AVATAR = 72;
/** At or above this font scale the tile grid falls back to two per row. */
const LARGE_TEXT_SCALE = 1.35;
const GUTTER = 20;
const GAP = 12;
/** Search bar and filter icon share one row: 85% / 15%. */
const SEARCH_SHARE = 85;
const FILTER_SHARE = 15;

function useDiscoverPort(override?: DiscoverPort): DiscoverPort {
  return useMemo(() => {
    if (override !== undefined) return override;
    const rt = getApiRuntime();
    return rt !== null ? new ApiDiscoverPort(withGuestStore(createAdapterContext(rt), getGuestStore())) : new InMemoryDiscoverPort(EMPTY_DISCOVER);
  }, [override]);
}

function CategoryTileView(props: { tile: (typeof CATEGORY_TILES)[number]; onPress: () => void }) {
  const { t } = useTranslation();
  const name = t(`worlds.category.${props.tile.id}`);
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={t("worlds.browseCategory", { name })} style={{ flex: 1, minWidth: 96 }} scale={0.99} testID={`discover-tile-${props.tile.id}`}>
      <View style={{ gap: 6 }}>
        <View style={{ aspectRatio: 0.75, overflow: "hidden", borderRadius: radius.lg }}>
          <ProductArt kind={props.tile.kind} seed={`cat-${props.tile.id}`} ratio="3:4" style={{ position: "absolute", top: 0, start: 0, end: 0, bottom: 0 }} />
        </View>
        <Text variant="caption" weight="600" numberOfLines={2} maxScale={1.5} accessibilityRole="none">{name}</Text>
      </View>
    </PressScale>
  );
}

/** Discover tab ("For you"): inline search, department avatars, personal rails, a 3-up category grid, Style me and the store directory entry. */
export function WorldsScreen(props: { searchPort?: SearchPort; discoverPort?: DiscoverPort }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const services = useServices();
  const { fontScale } = useWindowDimensions();
  const search = useMemo(() => props.searchPort ?? getFeaturePorts().search, [props.searchPort]);
  const discover = useDiscoverPort(props.discoverPort);
  const guest = useGuestMode();
  const [paused, setPaused] = useState(() => { try { return getGuestStore().getState().settings.historyPaused; } catch { return false; } });
  const [searching, setSearching] = useState(false);
  const [tree, setTree] = useState<readonly CategoryNode[]>([]);
  const [treeFailed, setTreeFailed] = useState(false);
  const [stores, setStores] = useState<readonly StoreSummary[]>([]);
  const [state, setState] = useState<DiscoverScreenState>({ status: "loading" });
  const [windowNode, setWindowNode] = useState<CategoryNode | null>(null);
  const [counts, setCounts] = useState<CategoryCounts | undefined>(undefined);
  const [filterSheet, setFilterSheet] = useState(false);
  const [filters, setFilters] = useState<ListingFilters>(EMPTY_LISTING_FILTERS);

  const loadTree = useCallback(() => {
    setTreeFailed(false);
    getFeaturePorts().categories.tree().then(setTree, () => setTreeFailed(true));
  }, []);
  const loadDiscover = useCallback(() => {
    setState({ status: "loading" });
    discover.load(null).then((data) => setState({ status: "ready", data }), (e: unknown) => setState(discoverFailure(e)));
  }, [discover]);
  useEffect(() => {
    loadTree();
    loadDiscover();
    getFeaturePorts().worlds.listStores().then(setStores, () => undefined);
  }, [loadTree, loadDiscover]);

  const perRow = fontScale >= LARGE_TEXT_SCALE ? TILES_PER_ROW_LARGE_TEXT : TILES_PER_ROW;
  const rows = rowsOf(CATEGORY_TILES, perRow);

  const openWindow = (slug: string, source: "discover_tile" | "discover_department", fallback: () => void) => {
    const node = nodeForSlug(tree, slug);
    if (node === null) { fallback(); return; }
    if (opensDirectly(tree, node)) { router.push({ pathname: "/shop-all", params: shopAllParams(node) }); return; }
    void services.analytics.track("category_window_opened", { category_id: node.id, source });
    setCounts(undefined);
    setWindowNode(node);
    void loadCategoryCounts(search, {}).then(setCounts);
  };

  const track = services.analytics;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, display: searching ? "none" : "flex" }}>
        <Screen padded={false}>
          <View style={{ gap: 28 }}>
            <View style={{ paddingHorizontal: GUTTER, gap: 16 }}>
              <Reveal index={0}><Text variant="display" accessibilityRole="header">{t("forYou.title")}</Text></Reveal>
              {/* Search bar 85% + the single filter icon 15% */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: GAP }}>
                <PressScale onPress={() => setSearching(true)} accessibilityRole="search" accessibilityLabel={t("forYou.searchPlaceholder")} testID="discover-search" style={{ flex: SEARCH_SHARE }}
                  innerStyle={{ minHeight: 48, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Icon name="search-outline" size={20} color="textSecondary" />
                  <Text variant="callout" secondary accessibilityRole="none" numberOfLines={1} style={{ flexShrink: 1 }}>{t("forYou.searchPlaceholder")}</Text>
                </PressScale>
                <View style={{ flex: FILTER_SHARE, alignItems: "center" }}>
                  <FilterButton count={badgeCount(filters)} onPress={() => setFilterSheet(true)} testID="discover-filter-button" />
                </View>
              </View>
            </View>

            <View accessibilityLabel={t("worlds.discover.departmentsLabel")} style={{ paddingHorizontal: GUTTER, flexDirection: "row", justifyContent: "space-between" }}>
              {DISCOVER_DEPARTMENTS.map((d) => {
                const label = t(`worlds.discover.${d.id}`);
                const go = () => router.push({ pathname: "/shop-all", params: departmentParams(d.id, label) });
                return (
                  <PressScale key={d.id} onPress={() => (d.id === "lifestyle" ? go() : openWindow(d.id, "discover_department", go))} accessibilityRole="button" accessibilityLabel={label} testID={`discover-dept-${d.id}`}
                    innerStyle={{ alignItems: "center", gap: 8, minWidth: 44, minHeight: 44 }}>
                    <View style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, overflow: "hidden" }}>
                      <ProductArt kind={d.kind} seed={`dept-${d.id}`} ratio="1:1" style={{ position: "absolute", top: 0, start: 0, end: 0, bottom: 0 }} />
                    </View>
                    <Text variant="caption" accessibilityRole="none">{label}</Text>
                  </PressScale>
                );
              })}
            </View>

            <DiscoverModules state={state} onRetry={loadDiscover} onOpenSettings={() => router.push("/privacy-center")}
              {...(guest ? { onClearLocalHistory: () => { getGuestStore().clearHistory(); loadDiscover(); }, historyPaused: paused, onTogglePause: (on: boolean) => { getGuestStore().setHistoryPaused(on); setPaused(on); loadDiscover(); } } : {})} />

            <View style={{ gap: 14 }}>
              <View style={{ paddingHorizontal: GUTTER }}><SectionHeader title={t("forYou.exploreCategories")} /></View>
              <View style={{ gap: 16, paddingHorizontal: GUTTER }} testID="discover-category-grid">
                {rows.map((r, ri) => (
                  <Reveal key={r[0]?.id} index={ri} style={{ flexDirection: "row", gap: GAP }}>
                    {r.map((c) => (
                      <CategoryTileView key={c.id} tile={c} onPress={() => openWindow(c.id, "discover_tile", () => router.push({ pathname: "/shop-all", params: { q: t(`worlds.category.${c.id}`) } }))} />
                    ))}
                    {Array.from({ length: perRow - r.length }, (_, i) => <View key={`pad-${i}`} style={{ flex: 1, minWidth: 96 }} />)}
                  </Reveal>
                ))}
              </View>
            </View>

            <View style={{ paddingHorizontal: GUTTER }}>
              <View style={{ borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 20, gap: 8 }}>
                <Text variant="quote" accessibilityRole="header">{t("worlds.discover.styleMeTitle")}</Text>
                <Text variant="callout" secondary>{t("worlds.discover.styleMeBody")}</Text>
                <View style={{ marginTop: 8 }}>
                  <Button title={t("worlds.discover.styleMeCta")} onPress={() => router.push("/stylist")} testID="discover-style-me" />
                </View>
              </View>
            </View>

            <PressScale onPress={() => router.push("/stores")} accessibilityRole="button" accessibilityLabel={t("forYou.stores")} testID="discover-stores"
              style={{ paddingHorizontal: GUTTER }} innerStyle={{ minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Text variant="callout" weight="600" accessibilityRole="none">{t("worlds.discover.storesTitle")}</Text>
                <Text variant="caption" secondary accessibilityRole="none">{t("worlds.discover.storesBody")}</Text>
              </View>
              <Icon name="chevron-forward" size={18} color="textSecondary" directional />
            </PressScale>
          </View>
        </Screen>
      </View>

      {searching ? (
        <InlineSearch
          port={search} tree={tree} stores={stores}
          onCancel={() => setSearching(false)}
          onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })}
          onSuggestionTapped={(e) => void track.track("search_suggestion_tapped", e)}
          onSearched={(e) => {
            void track.track("search_performed", { term_char_count: e.termChars, result_count: Math.min(e.resultCount, 1000), scope: "discover_inline", has_filters: e.hasFilters });
            if (e.resultCount === 0) void track.track("search_no_result", { term_char_count: e.termChars, scope: "shop_everything", has_filters: e.hasFilters });
          }}
        />
      ) : null}

      <FilterSheet
        visible={filterSheet} onClose={() => setFilterSheet(false)} filters={filters} tree={tree} treeFailed={treeFailed} stores={stores}
        signedIn={false} budgetReady={false} onSetupBudget={() => undefined}
        onApply={(next) => {
          // Filters on Discover open the listing with them applied; Discover itself keeps no filter state beyond the badge.
          setFilters(EMPTY_LISTING_FILTERS);
          setFilterSheet(false);
          router.push({ pathname: "/shop-all", params: toRouteParams(next) });
        }}
      />

      <CategoryWindow
        visible={windowNode !== null} onClose={() => setWindowNode(null)} node={windowNode} tree={tree} treeLoading={false} treeFailed={treeFailed}
        onRetry={loadTree} counts={counts}
        onSelect={(target, _row, hasCount) => {
          void track.track("category_window_selected", { category_id: target.id, has_count: hasCount });
          setWindowNode(null);
          router.push({ pathname: "/shop-all", params: shopAllParams(target) });
        }}
      />
    </View>
  );
}
