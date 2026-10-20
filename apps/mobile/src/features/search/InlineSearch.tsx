import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { EmptyState, ErrorState, IconButton, ListRow, Screen, SearchField, Text, useTheme } from "../../ui";
import { Illustration } from "../../art";
import { useServices } from "../../state/services";
import { useFormat } from "../home/parts";
import { GridSkeleton } from "../home/parts";
import { FilterButton } from "../filters/FilterButton";
import { FilterSheet } from "../filters/FilterSheet";
import { EMPTY_LISTING_FILTERS, badgeCount, toSearchFilter, type ListingFilters } from "../filters/model";
import type { CategoryNode } from "../shop-all/model";
import type { StoreSummary } from "../worlds/model";
import {
  EMPTY_SUGGESTIONS, KIND_KEY, LatestOnly, SUGGEST_DEBOUNCE_MS, clampQuery, panelMode, panelRecents, suggestionTap,
} from "../discover/inline-search";
import { BoardResults } from "./BoardResults";
import {
  RECENTS_KEY, addRecent, decodeRecents, encodeRecents, groupSuggestions, runSearch, searchFailure,
  type SearchOutcome, type SearchPort, type Suggestion, type SuggestionInput,
} from "./model";

type ResultState = { readonly kind: "none" } | { readonly kind: "loading" } | { readonly kind: "error"; readonly offline: boolean } | SearchOutcome;

export interface InlineSearchProps {
  readonly port: SearchPort;
  readonly tree: readonly CategoryNode[];
  readonly stores: readonly StoreSummary[];
  readonly onCancel: () => void;
  readonly onOpenProduct: (id: string) => void;
  /** A single camera icon in the field; only when kill.visual_search is open. */
  readonly onVisualSearch?: (() => void) | undefined;
  readonly onSuggestionTapped?: ((e: { kind: Suggestion["kind"]; position: number }) => void) | undefined;
  readonly onSearched?: ((e: { termChars: number; resultCount: number; hasFilters: boolean }) => void) | undefined;
}

const kindIcon = { query: "search-outline", store: "storefront-outline", category: "shirt-outline" } as const;

/**
 * Inline search of the Discover tab: expands in place (no navigation). Up to 5 recents (device only) or 5 grouped suggestions,
 * results on the same screen with one filter icon. Offline shows recents only; a failed suggestion call is silent.
 */
export function InlineSearch(props: InlineSearchProps) {
  const { t } = useTranslation();
  const f = useFormat();
  const { colors } = useTheme();
  const services = useServices();
  const [typed, setTyped] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [input, setInput] = useState<SuggestionInput>(EMPTY_SUGGESTIONS);
  const [result, setResult] = useState<ResultState>({ kind: "none" });
  const [filters, setFilters] = useState<ListingFilters>(EMPTY_LISTING_FILTERS);
  const [sheet, setSheet] = useState(false);
  const suggestSeq = useRef(new LatestOnly());
  const searchSeq = useRef(new LatestOnly());
  const { query, tooLong } = clampQuery(typed);
  const mode = panelMode(typed, submitted);
  const suggestions = useMemo(() => groupSuggestions(input), [input]);

  useEffect(() => {
    void services.storage.getString(RECENTS_KEY).then((r) => setRecents(decodeRecents(r)), () => undefined);
  }, [services]);

  useEffect(() => {
    if (mode !== "suggestions") { setInput(EMPTY_SUGGESTIONS); return; }
    const id = suggestSeq.current.begin();
    const timer = setTimeout(() => {
      const run = props.port.suggestGrouped !== undefined
        ? props.port.suggestGrouped(query)
        : props.port.suggest(query).then((queries): SuggestionInput => ({ queries, stores: [], categories: [] }));
      run.then((s) => { if (suggestSeq.current.accepts(id)) setInput(s); }, () => { if (suggestSeq.current.accepts(id)) setInput(EMPTY_SUGGESTIONS); });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [props.port, query, mode]);

  const saveRecents = useCallback((next: readonly string[]) => {
    setRecents(next);
    void services.storage.setString(RECENTS_KEY, encodeRecents(next)).catch(() => undefined);
  }, [services]);

  const submit = useCallback(async (raw: string, lf: ListingFilters) => {
    const c = clampQuery(raw);
    if (c.query.length === 0) return;
    const id = searchSeq.current.begin();
    setTyped(c.query);
    setSubmitted(true);
    setResult({ kind: "loading" });
    saveRecents(addRecent(recents, c.query));
    const hasFilters = badgeCount(lf) > 0;
    try {
      const out = await runSearch(props.port, c.query, toSearchFilter(lf, props.tree));
      if (!searchSeq.current.accepts(id)) return;
      setResult(out);
      props.onSearched?.({ termChars: c.query.length, resultCount: out.kind === "results" || out.kind === "relaxed" ? out.total : 0, hasFilters });
    } catch (e) {
      if (searchSeq.current.accepts(id)) setResult({ kind: "error", ...searchFailure(e) });
    }
  }, [props, recents, saveRecents]);

  const edit = (v: string) => { setTyped(v); setSubmitted(false); setResult({ kind: "none" }); searchSeq.current.begin(); };
  const hit = recents.length > 0 ? panelRecents(recents) : [];
  const out = result.kind === "results" || result.kind === "relaxed" ? result : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }} testID="inline-search">
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("inlineSearch.cancel")} onPress={props.onCancel} testID="inline-search-cancel" style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}>
          <Text variant="callout" accessibilityRole="none">{t("inlineSearch.cancel")}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <SearchField
            autoFocus value={typed} onChangeText={edit} onSubmit={() => void submit(typed, filters)} placeholder={t("inlineSearch.placeholder")}
            testID="inline-search-input"
            trailing={props.onVisualSearch !== undefined ? <IconButton icon="camera-outline" label={t("inlineSearch.camera")} onPress={props.onVisualSearch} testID="inline-search-camera" /> : undefined}
          />
        </View>
        {submitted ? <FilterButton count={badgeCount(filters)} onPress={() => setSheet(true)} testID="inline-search-filter" /> : null}
      </View>

      <Screen padded={false}>
        <View style={{ paddingHorizontal: 20, gap: 4 }}>
          {tooLong ? <View accessibilityLiveRegion="polite"><Text variant="caption" color="danger">{t("inlineSearch.queryTooLong", { max: f.num(100) })}</Text></View> : null}

          {mode === "recents" && hit.length > 0 ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text variant="eyebrow" secondary accessibilityRole="header">{t("inlineSearch.recent")}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t("inlineSearch.clearRecents")} onPress={() => saveRecents([])} style={{ minHeight: 44, justifyContent: "center" }} testID="inline-search-clear-recents">
                  <Text variant="caption" weight="600" accessibilityRole="none">{t("inlineSearch.clearRecents")}</Text>
                </Pressable>
              </View>
              {hit.map((r) => (
                <View key={r} style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={{ flex: 1 }}><ListRow title={r} leadingIcon="time-outline" onPress={() => void submit(r, filters)} chevron={false} /></View>
                  <IconButton icon="close" label={t("inlineSearch.removeRecent", { query: r })} onPress={() => saveRecents(recents.filter((x) => x !== r))} />
                </View>
              ))}
            </>
          ) : null}

          {mode === "suggestions" && suggestions.length > 0 ? (
            <>
              <Text variant="eyebrow" secondary accessibilityRole="header">{t("inlineSearch.suggestions")}</Text>
              {suggestions.map((s, i) => (
                <ListRow
                  key={`${s.kind}-${s.id ?? s.label}`} title={s.label} subtitle={t(KIND_KEY[s.kind])} leadingIcon={kindIcon[s.kind]} chevron={false}
                  onPress={() => { props.onSuggestionTapped?.(suggestionTap(s, i)); void submit(s.label, filters); }} testID={`inline-suggestion-${i}`}
                />
              ))}
            </>
          ) : null}

          {mode === "results" && result.kind === "loading" ? <GridSkeleton /> : null}
          {mode === "results" && result.kind === "error" ? (
            <ErrorState offline={result.offline} title={t(result.offline ? "inlineSearch.offline" : "forYou.moduleFailed")} description="" retryTitle={t("forYou.retry")} onRetry={() => void submit(typed, filters)} />
          ) : null}
          {mode === "results" && result.kind === "empty" ? (
            <EmptyState illustration={<Illustration name="noResults" size={120} />} title={t("inlineSearch.noResults")} description="" actionTitle={t("inlineSearch.cancel")} onAction={props.onCancel} />
          ) : null}
        </View>
        {mode === "results" && out !== null ? (
          <View style={{ marginTop: 8 }} testID="inline-search-results"><BoardResults items={out.items} onOpen={props.onOpenProduct} /></View>
        ) : null}
      </Screen>

      <FilterSheet
        visible={sheet} onClose={() => setSheet(false)} filters={filters} tree={props.tree} treeFailed={false} stores={props.stores}
        signedIn={false} budgetReady={false} onSetupBudget={() => undefined}
        onApply={(next) => { setFilters(next); setSheet(false); void submit(typed, next); }}
      />
    </View>
  );
}
