import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BottomSheet, Button, Checkbox, EmptyState, ErrorState, GlassSurface, Icon, PressScale, Reveal, Screen, SearchField, Text, TextField, useTheme } from "../../ui";
import { Illustration } from "../../art";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { getFeaturePorts } from "../../state/ports";
import { useServices } from "../../state/services";
import { CATEGORY_TILES, type StoreSummary } from "../worlds/model";
import { inferKind, type HomeProduct } from "../home/model";
import { GridSkeleton } from "../home/parts";
import { opt } from "./optional";
import { Chip } from "./Chip";
import { BoardPill, DropdownPill } from "./BoardControls";
import { BoardResults } from "./BoardResults";
import {
  CONDITIONS, EMPTY_FILTER, RECENTS_KEY, addRecent, decodeRecents, encodeRecents, normalizeQuery, parseBudgetEgp,
  runSearch, searchFailure, toggleCondition, type SearchFilter, type SearchItem, type SearchOutcome, type SearchPort,
} from "./model";

type View_ = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "error"; readonly offline: boolean } | SearchOutcome;
type Tab = "products" | "brands" | "categories";
type RowIcon = "search-outline" | "storefront-outline" | "shirt-outline" | "time-outline";

export function toTile(i: SearchItem): HomeProduct {
  return {
    id: i.id, title: i.title, storeId: "", storeName: i.storeName, kind: inferKind(i.title), price: i.price,
    referencePrice: i.referencePrice ?? null, verifiedPct: i.verifiedDiscountPct, isLaunchPrice: false, createdAtMs: 0, endsAtMs: null, sponsored: i.sponsored,
  };
}

function Row(p: { label: string; icon: RowIcon; index?: number; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Reveal index={p.index ?? 0}>
      <PressScale accessibilityRole="button" accessibilityLabel={p.label} onPress={p.onPress} innerStyle={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
          <Icon name={p.icon} size={18} color="textSecondary" />
        </View>
        <Text variant="body" style={{ flex: 1 }} numberOfLines={1} accessibilityRole="none">{p.label}</Text>
        <Icon name="chevron-forward" size={16} color="textSecondary" directional />
      </PressScale>
    </Reveal>
  );
}
function Heading(p: { children: string }) {
  return <Text variant="eyebrow" secondary accessibilityRole="header" style={{ marginTop: 24, marginBottom: 4 }}>{p.children}</Text>;
}

/** Full-screen glass search overlay: instant suggestions, device-only recents, filter sheet, results grid. */
export function SearchScreen(props: { port?: SearchPort; onOpenProduct?: (id: string) => void; onClose?: () => void; initialQuery?: string; stores?: readonly StoreSummary[]; onVisualSearch?: () => void }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const services = useServices();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<SearchPort>(() => props.port ?? getFeaturePorts().search, [props.port]);
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [filter, setFilter] = useState<SearchFilter>(EMPTY_FILTER);
  const [budgetText, setBudgetText] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [stores, setStores] = useState<readonly StoreSummary[]>(props.stores ?? []);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [view, setView] = useState<View_>({ kind: "idle" });
  const [typing, setTyping] = useState(props.initialQuery === undefined || props.initialQuery.length === 0);
  const [tab, setTab] = useState<Tab>("products");
  const seq = useRef(0);
  const currency = t("common.currency");
  const num = (n: number) => localizeDigits(String(n), locale);

  useEffect(() => {
    void services.storage.getString(RECENTS_KEY).then((r) => setRecents(decodeRecents(r)), () => undefined);
    if (props.stores === undefined) void getFeaturePorts().worlds.listStores().then(setStores, () => undefined);
  }, [services, props.stores]);

  useEffect(() => {
    let alive = true;
    port.suggest(query).then((s) => { if (alive) setSuggestions(s); }, () => { if (alive) setSuggestions([]); });
    return () => { alive = false; };
  }, [port, query]);

  useEffect(() => {
    if (!sheetOpen) return;
    let alive = true;
    setLiveCount(null);
    port.count(normalizeQuery(query), filter).then((c) => { if (alive) setLiveCount(c); }, () => { if (alive) setLiveCount(null); });
    return () => { alive = false; };
  }, [port, sheetOpen, query, filter]);

  const submit = async (raw: string, f: SearchFilter) => {
    const id = ++seq.current;
    setTyping(false);
    setView({ kind: "loading" });
    const next = addRecent(recents, raw);
    if (next !== recents) { setRecents(next); void services.storage.setString(RECENTS_KEY, encodeRecents(next)).catch(() => undefined); }
    try {
      const out = await runSearch(port, raw, f);
      if (id === seq.current) setView(out);
    } catch (e) {
      if (id === seq.current) setView({ kind: "error", ...searchFailure(e) });
    }
  };
  useEffect(() => {
    if (props.initialQuery !== undefined && props.initialQuery.length > 0) void submit(props.initialQuery, EMPTY_FILTER);
    // run once for the deep-linked query
  }, []);

  const clearRecents = () => { setRecents([]); void services.storage.setString(RECENTS_KEY, encodeRecents([])).catch(() => undefined); };
  const setBudget = (text: string) => { setBudgetText(text); setFilter((f) => ({ ...f, budgetMax: parseBudgetEgp(text) })); };
  const budgetInvalid = budgetText.trim().length > 0 && parseBudgetEgp(budgetText) === null;
  const q = normalizeQuery(query).toLowerCase();
  const storeHits = q.length === 0 ? [] : stores.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 3);
  const catHits = q.length === 0 ? [] : CATEGORY_TILES.filter((c) => t(`worlds.category.${c.id}`).toLowerCase().includes(q)).slice(0, 3);
  const run = (s: string) => { setQuery(s); void submit(s, filter); };

  const onProducts = tab === "products";
  const showSuggest = onProducts && typing && q.length > 0;
  const showRecents = onProducts && typing && q.length === 0;
  const brandList = q.length === 0 ? stores.slice(0, 20) : stores.filter((s) => s.name.toLowerCase().includes(q));
  const categoryList = CATEGORY_TILES.filter((c) => q.length === 0 || t(`worlds.category.${c.id}`).toLowerCase().includes(q));
  const onSale = filter.verifiedDiscountOnly;
  const toggleOnSale = () => {
    const next = { ...filter, verifiedDiscountOnly: !onSale };
    setFilter(next);
    if (!typing || view.kind !== "idle") void submit(query, next);
  };
  const devFacets = __DEV__ && port.supportsDevFacets === true;
  const toggleFacet = (k: "newIn" | "inStock") => {
    const next = { ...filter, [k]: filter[k] !== true };
    setFilter(next);
    if (!typing || view.kind !== "idle") void submit(query, next);
  };
  const results = view.kind === "results" || view.kind === "relaxed" ? view : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Screen contentStyle={{ paddingTop: insets.top + 234 }}>
        {showRecents ? (
          <View style={{ gap: 4 }}>
            {recents.length > 0 ? (
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Heading>{t("search.recentTitle")}</Heading>
                  <Pressable accessibilityRole="button" accessibilityLabel={t("search.clearRecents")} onPress={clearRecents} style={{ minHeight: 44, justifyContent: "center" }}>
                    <Text variant="caption" secondary style={{ textDecorationLine: "underline" }} accessibilityRole="none">{t("search.clearRecents")}</Text>
                  </Pressable>
                </View>
                {recents.map((r, i) => <Row key={r} index={i} label={r} icon="time-outline" onPress={() => run(r)} />)}
                <Text variant="caption" secondary>{t("search.onDeviceNote")}</Text>
              </>
            ) : null}
            <Heading>{t("search.suggestCategories")}</Heading>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 }}>
              {CATEGORY_TILES.map((c) => <Chip key={c.id} label={t(`worlds.category.${c.id}`)} selected={false} onPress={() => run(t(`worlds.category.${c.id}`))} />)}
            </View>
          </View>
        ) : null}

        {showSuggest ? (
          <View accessibilityLabel={t("search.suggestionsName")}>
            {suggestions.length > 0 ? <Heading>{t("search.suggestQueries")}</Heading> : null}
            {suggestions.map((s, i) => <Row key={s} index={i} label={s} icon="search-outline" onPress={() => run(s)} />)}
            {storeHits.length > 0 ? <Heading>{t("search.suggestStores")}</Heading> : null}
            {storeHits.map((s, i) => <Row key={s.id} index={i} label={s.name} icon="storefront-outline" onPress={() => run(s.name)} />)}
            {catHits.length > 0 ? <Heading>{t("search.suggestCategories")}</Heading> : null}
            {catHits.map((c, i) => <Row key={c.id} index={i} label={t(`worlds.category.${c.id}`)} icon="shirt-outline" onPress={() => run(t(`worlds.category.${c.id}`))} />)}
            <View style={{ paddingTop: 16 }}><Button title={t("search.submit")} onPress={() => void submit(query, filter)} /></View>
          </View>
        ) : null}

        {tab === "brands" ? (
          brandList.length === 0 ? <Text variant="caption" secondary>{t("search.noBrandMatches")}</Text>
            : brandList.map((s, i) => <Row key={s.id} index={i} label={s.name} icon="storefront-outline" onPress={() => { setTab("products"); run(s.name); }} />)
        ) : null}
        {tab === "categories" ? (
          categoryList.length === 0 ? <Text variant="caption" secondary>{t("search.noCategoryMatches")}</Text>
            : categoryList.map((c, i) => <Row key={c.id} index={i} label={t(`worlds.category.${c.id}`)} icon="shirt-outline" onPress={() => { setTab("products"); run(t(`worlds.category.${c.id}`)); }} />)
        ) : null}

        {onProducts && view.kind === "loading" && !typing ? <GridSkeleton /> : null}
        {onProducts && view.kind === "error" ? (
          <ErrorState offline={view.offline} title={t(view.offline ? "search.offlineTitle" : "search.errorTitle")} description={t(view.offline ? "search.offlineBody" : "search.errorBody")} retryTitle={t("common.retry")} onRetry={() => void submit(query, filter)} />
        ) : null}
        {onProducts && view.kind === "empty" && !typing ? (
          <EmptyState illustration={<Illustration name="noResults" size={120} />} title={t("search.emptyTitle")} description={t("search.emptyBody")} actionTitle={t("search.clear")} onAction={() => { setFilter(EMPTY_FILTER); setBudgetText(""); void submit(query, EMPTY_FILTER); }} />
        ) : null}
        {onProducts && results !== null && !typing ? (
          <View style={{ marginHorizontal: -16 }}>
            <View style={{ paddingHorizontal: 20, gap: 6, ...(view.kind === "relaxed" ? { paddingBottom: 16 } : {}) }}>
              {view.kind === "relaxed" ? (
                <>
                  <Text variant="title2" accessibilityRole="header">{t("search.zeroRelaxedTitle")}</Text>
                  <Text variant="caption" secondary>{t("search.relaxed", { filters: view.dropped.map((d) => t(`search.filterName.${d}`)).join(t("search.listSeparator")) })}</Text>
                </>
              ) : null}
              <Text variant="eyebrow" secondary style={{ height: 0, opacity: 0 }}>{t("search.resultCount", { count: num(results.total) })}</Text>
            </View>
            <BoardResults items={results.items} onOpen={(id) => props.onOpenProduct?.(id)} />
          </View>
        ) : null}
      </Screen>

      <GlassSurface edges="bottom" style={{ position: "absolute", top: 0, start: 0, end: 0 }}>
        <View style={{ paddingTop: insets.top + 8, paddingBottom: 16, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <SearchField
              autoFocus
              value={query}
              onChangeText={(v) => { setQuery(v); setTyping(true); }}
              onSubmit={() => void submit(query, filter)}
              placeholder={t("search.searchHere")}
              label={t("search.queryLabel")}
              clearLabel={t("search.clear")}
              testID="search-input"
            />
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t("search.closeSearch")} onPress={() => props.onClose?.()} testID="search-close" style={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" }}>
            <Text variant="callout" accessibilityRole="none">{t("search.cancel")}</Text>
          </Pressable>
        </View>
        <View accessibilityRole="radiogroup" accessibilityLabel={t("search.tabsName")} style={{ paddingHorizontal: 20, paddingBottom: 20, flexDirection: "row", gap: 10 }}>
          {(["products", "brands", "categories"] as const).map((k) => (
            <BoardPill key={k} fill role="radio" label={t(k === "products" ? "search.tabProducts" : k === "brands" ? "search.tabBrands" : "search.tabCategories")} selected={tab === k} onPress={() => setTab(k)} />
          ))}
        </View>
        {onProducts ? (
          <>
            <View style={{ paddingHorizontal: 20, paddingBottom: 18, flexDirection: "row", gap: 10 }}>
              <BoardPill role="checkbox" label={t("search.onSale")} selected={onSale} onPress={toggleOnSale} />
              {devFacets ? <BoardPill role="checkbox" label={t("search.chipNewIn")} selected={filter.newIn === true} onPress={() => toggleFacet("newIn")} testID="search-chip-new" /> : null}
              {devFacets ? <BoardPill role="checkbox" label={t("search.chipInStock")} selected={filter.inStock === true} onPress={() => toggleFacet("inStock")} testID="search-chip-stock" /> : null}
            </View>
            <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", gap: 14 }}>
              <DropdownPill flex={0.9} label={t("search.pillSort")} onPress={() => setSheetOpen(true)} testID="search-filters" />
              <DropdownPill flex={1.05} label={t("search.pillBrand")} onPress={() => setSheetOpen(true)} />
              <DropdownPill flex={1.2} label={t("search.pillSize")} onPress={() => setSheetOpen(true)} />
            </View>
          </>
        ) : null}
      </GlassSurface>

      <BottomSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title={t("search.sheetTitle")}>
        <TextField
          label={t("search.budgetLabel", { currency })}
          helper={t("search.budgetHelper")}
          {...opt("error", budgetInvalid ? t("search.budgetInvalid") : undefined)}
          value={budgetText}
          keyboardType="numeric"
          onChangeText={setBudget}
        />
        <Checkbox label={t("search.mySize")} value={filter.mySizeOnly} onValueChange={(v) => setFilter((f) => ({ ...f, mySizeOnly: v }))} />
        <Checkbox label={t("search.verifiedOnly")} value={filter.verifiedDiscountOnly} onValueChange={(v) => setFilter((f) => ({ ...f, verifiedDiscountOnly: v }))} />
        <Text variant="eyebrow" secondary>{t("search.conditionHeading")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {CONDITIONS.map((c) => <Chip key={c} role="checkbox" label={t(`search.condition.${c}`)} selected={filter.conditions.includes(c)} onPress={() => setFilter((f) => toggleCondition(f, c))} />)}
        </View>
        <Text variant="eyebrow" secondary>{t("search.paymentHeading")}</Text>
        <Checkbox label={t("search.installments")} value={filter.installmentsAvailable} onValueChange={(v) => setFilter((f) => ({ ...f, installmentsAvailable: v }))} />
        <Checkbox label={t("search.payableWithCredit")} value={filter.payableWithCredit} onValueChange={(v) => setFilter((f) => ({ ...f, payableWithCredit: v }))} />
        <Text variant="caption" secondary>{t("search.installmentsNote")}</Text>
        <View accessibilityLiveRegion="polite">
          <Button
            title={liveCount === null ? t("search.apply") : t("search.showResults", { count: num(liveCount) })}
            disabled={budgetInvalid}
            onPress={() => { setSheetOpen(false); void submit(query, filter); }}
          />
        </View>
        <Button variant="ghost" title={t("search.clear")} onPress={() => { setFilter(EMPTY_FILTER); setBudgetText(""); }} />
      </BottomSheet>
    </View>
  );
}
