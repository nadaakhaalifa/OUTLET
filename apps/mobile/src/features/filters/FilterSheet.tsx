import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import { Accordion, BottomSheet, Button, Text, type AccordionSection } from "../../ui";
import { pluralKey } from "../../i18n/plural";
import { useFormat } from "../home/parts";
import { restoreFilterFocus } from "./FilterButton";
import { useBudgetDraft } from "../shop-all/BudgetSheet";
import type { CategoryNode } from "../shop-all/model";
import type { FacetCounts } from "../search/model";
import type { StoreSummary } from "../worlds/model";
import {
  COUNT_DEBOUNCE_MS, INITIAL_COUNT, beginCount, cancelCount, changedKeys, sanitizeForSession, countUnavailable, failCount, footerCount, listingReducer, resolveCount,
  sectionSelectedCount, visibleSections, type CountState, type FilterEvent, type FilterSectionId, type ListingFilters,
} from "./model";
import { BrandBody, BudgetBody, WorldBody, CategoriesBody, DiscountBody, MoreBody, PriceBody, SortBody } from "./sections";

export interface WorldSection {
  readonly value: string;
  /** The unfiltered option (no summary is shown for it). */
  readonly defaultValue: string;
  readonly options: readonly string[];
  /** Already-localized label of an option. */
  readonly label: (option: string) => string;
  readonly onChange: (option: string) => void;
}

export interface FilterSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Applied state. The sheet edits a draft; closing without "Show" discards it. */
  readonly filters: ListingFilters;
  readonly onApply: (next: ListingFilters) => void;
  readonly tree: readonly CategoryNode[];
  readonly treeFailed: boolean;
  readonly stores: readonly StoreSummary[];
  /** Budget section is absent when false (the server answers 400 to budget facets for anonymous callers). */
  readonly signedIn: boolean;
  /** Monthly budget set and `budget_insights` consent granted. */
  readonly budgetReady: boolean;
  readonly onSetupBudget: () => void;
  /** Live count for a draft (total_estimate). Receives the draft with `fitsBudget` already stripped when logged out or without a budget; `signal` aborts on close or when a newer request starts. Omit to show "Show items" with no number. */
  readonly countFor?: ((draft: ListingFilters, signal?: AbortSignal) => Promise<number>) | undefined;
  /** Per-option counts from the server; omitted until the API sends them. */
  readonly facetCounts?: FacetCounts | undefined;
  readonly onEvent?: ((e: FilterEvent) => void) | undefined;
  /** Visible-section allow-list (e.g. Saved shows only "sort" and "more"). Default: every section the data supports. */
  readonly sections?: readonly FilterSectionId[] | undefined;
  /** Native "world" section. Applies immediately (the world is screen state, not part of the draft). */
  readonly world?: WorldSection | undefined;
  /** Saved-only (WP-6): replaces the Sort body and/or appends sections. */
  readonly sortSection?: ReactNode;
  readonly extraSections?: readonly AccordionSection[] | undefined;
  readonly testID?: string | undefined;
}

/** The one shared filter sheet: accordion sections (one open), applied via the sticky footer, with a debounced live count that drops stale answers. */
export function FilterSheet(props: FilterSheetProps) {
  const f = useFormat();
  const [draft, dispatch] = useReducer(listingReducer, props.filters);
  const [count, setCount] = useState<CountState>(INITIAL_COUNT);
  const countRef = useRef<CountState>(INITIAL_COUNT);
  // Seeded from the APPLIED filters, never the draft: a price typed and discarded must not come back on reopen.
  const price = useBudgetDraft({ min: props.filters.priceMin, max: props.filters.priceMax }, props.visible);
  const wasOpen = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const onEvent = props.onEvent;

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Ids keep increasing across opens and closes: a late answer from the previous open is never accepted.
    countRef.current = cancelCount(countRef.current);
    setCount(countRef.current);
    if (props.visible) {
      wasOpen.current = true;
      dispatch({ type: "replace", filters: props.filters });
      onEvent?.({ type: "opened" });
    } else if (wasOpen.current) {
      wasOpen.current = false;
      restoreFilterFocus();
    }
  }, [props.visible]);

  // The price fields feed the draft whenever they parse; an invalid pair leaves the draft unchanged.
  const parsed = price.parsed;
  useEffect(() => {
    if (props.visible && parsed.ok && (parsed.budget.min !== draft.priceMin || parsed.budget.max !== draft.priceMax)) {
      dispatch({ type: "setPrice", min: parsed.budget.min, max: parsed.budget.max });
    }
  }, [props.visible, parsed.ok, parsed.budget.min, parsed.budget.max]);

  const session = { signedIn: props.signedIn, budgetReady: props.budgetReady };
  const effective = sanitizeForSession(draft, session);
  const countFor = props.countFor;
  useEffect(() => {
    if (!props.visible || countFor === undefined) return;
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      const begun = beginCount(countRef.current);
      countRef.current = begun.state;
      setCount(begun.state);
      countFor(effective, ctl.signal).then(
        (n) => { countRef.current = resolveCount(countRef.current, begun.id, n); setCount(countRef.current); },
        () => { countRef.current = failCount(countRef.current, begun.id); setCount(countRef.current); },
      );
    }, COUNT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [props.visible, effective, countFor]);

  const sections = visibleSections({ signedIn: props.signedIn, budgetReady: props.budgetReady, storeCount: props.stores.filter((s) => s.status === "active").length, categoryCount: props.tree.length, world: props.world !== undefined, ...(props.sections !== undefined ? { only: props.sections } : {}) });
  const title = (id: FilterSectionId): string => f.t(`filterSheet.section${id.charAt(0).toUpperCase()}${id.slice(1)}`);
  const summary = (id: FilterSectionId): string | null => {
    const n = sectionSelectedCount(draft, id);
    if (id === "world") return props.world !== undefined && props.world.value !== props.world.defaultValue ? props.world.label(props.world.value) : null;
    if (n === null) return null;
    return id === "sort" ? f.t(`shopAll.sortOption.${draft.sort}`) : f.t(pluralKey("filterSheet.selected", n), { n: f.num(n) });
  };
  const body = (id: FilterSectionId, mode: "normal" | "setup"): ReactNode => {
    switch (id) {
      case "sort": return props.sortSection ?? <SortBody filters={draft} dispatch={dispatch} />;
      case "world": return props.world === undefined ? null : <WorldBody world={props.world} />;
      case "brand": return <BrandBody filters={draft} stores={props.stores} counts={props.facetCounts} dispatch={dispatch} />;
      case "price": return <PriceBody draft={price} />;
      case "budget": return <BudgetBody filters={draft} mode={mode} onSetup={() => { props.onClose(); props.onSetupBudget(); }} dispatch={dispatch} />;
      case "categories": return <CategoriesBody filters={draft} tree={props.tree} failed={props.treeFailed} dispatch={dispatch} />;
      case "discount": return <DiscountBody filters={draft} dispatch={dispatch} />;
      case "more": return <MoreBody filters={draft} dispatch={dispatch} />;
    }
  };
  const accordion: AccordionSection[] = [
    ...sections.map((s): AccordionSection => ({ id: s.id, title: title(s.id), summary: summary(s.id), content: body(s.id, s.mode), testID: `filter-section-${s.id}` })),
    ...(props.extraSections ?? []),
  ];

  const n = footerCount(count);
  const footerLabel = n === null ? f.t("filterSheet.showItems") : f.t(pluralKey("filterSheet.showCount", n), { n: f.num(n) });
  useEffect(() => {
    if (props.visible && n !== null) AccessibilityInfo.announceForAccessibility(footerLabel);
  }, [props.visible, n]);
  const apply = (): void => {
    const keys = changedKeys(props.filters, effective);
    keys.forEach((k) => onEvent?.({ type: "applied", keys: [k], resultCount: n }));
    props.onApply(effective);
    props.onClose();
  };
  const reset = (): void => {
    dispatch({ type: "reset" });
    price.setDraft({ min: null, max: null });
    onEvent?.({ type: "reset" });
  };
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title={f.t("filterSheet.title")} closeLabel={f.t("filterSheet.close")} maxHeightRatio={0.92}>
      <ScrollView style={{ maxHeight: 460 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" testID={props.testID ?? "filter-sheet"}>
        <Accordion sections={accordion} initialOpen="sort" />
      </ScrollView>
      {countUnavailable(count) ? <Text variant="caption" secondary>{f.t("filterSheet.countUnavailable")}</Text> : null}
      <View style={{ gap: 8 }}>
        <Button title={footerLabel} disabled={!parsed.ok} onPress={apply} testID="filter-apply" />
        <Button title={f.t("filterSheet.reset")} variant="ghost" onPress={reset} testID="filter-reset" />
      </View>
    </BottomSheet>
  );
}
