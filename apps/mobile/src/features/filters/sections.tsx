import { useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import { Checkbox, Chip, ListRow, Radio, SearchField, SwitchRow, Text } from "../../ui";
import { useFormat } from "../home/parts";
import { BudgetFields, type useBudgetDraft } from "../shop-all/BudgetSheet";
import { CategoryPicker } from "../shop-all/CategorySheet";
import { AVATAR_DEPARTMENTS, DISCOUNT_STEPS, LOWEST_PRICE_DAYS, SHOP_SORTS, type CategoryNode } from "../shop-all/model";
import { CONDITIONS, type FacetCounts } from "../search/model";
import type { StoreSummary } from "../worlds/model";
import { MAX_BRAND_ROWS, MAX_FACET_VALUES, atFacetCap, brandRows, categoriesIncludeSubtree, type ListingAction, type ListingFilters } from "./model";

type Dispatch = (a: ListingAction) => void;

export function WorldBody(props: { world: { readonly value: string; readonly options: readonly string[]; readonly label: (o: string) => string; readonly onChange: (o: string) => void } }) {
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {props.world.options.map((o) => <Chip key={o} testID={`world-${o}`} label={props.world.label(o)} selected={o === props.world.value} role="radio" onPress={() => props.world.onChange(o)} />)}
    </View>
  );
}
const chipRow = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;

export function SortBody(props: { filters: ListingFilters; dispatch: Dispatch }) {
  const f = useFormat();
  return (
    <View style={{ gap: 8 }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={f.t("filterSheet.sectionSort")}>
        {SHOP_SORTS.map((s) => <Radio key={s} label={f.t(`shopAll.sortOption.${s}`)} selected={props.filters.sort === s} onPress={() => props.dispatch({ type: "setSort", sort: s })} />)}
      </View>
      <Text variant="caption" secondary>{f.t("filterSheet.sortNote")}</Text>
    </View>
  );
}

/** Says the total filter limit is reached, and announces it once when it becomes true. */
function CapNotice(props: { capped: boolean }) {
  const f = useFormat();
  const text = f.t("filterSheet.facetLimit", { max: f.num(MAX_FACET_VALUES) });
  useEffect(() => { if (props.capped) AccessibilityInfo.announceForAccessibility(text); }, [props.capped]);
  return props.capped ? <View accessibilityLiveRegion="polite"><Text variant="caption" color="danger">{text}</Text></View> : null;
}

/** Brand = stores today. Search inside (debounced), selected pinned on top, at most 30 rows. Counts appear only when the server sent them. */
export function BrandBody(props: { filters: ListingFilters; stores: readonly StoreSummary[]; counts?: FacetCounts | undefined; dispatch: Dispatch }) {
  const f = useFormat();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(text), 200); return () => clearTimeout(t); }, [text]);
  const rows = useMemo(() => brandRows(props.stores, props.filters.storeIds, q, props.counts, MAX_BRAND_ROWS), [props.stores, props.filters.storeIds, q, props.counts]);
  const capped = atFacetCap(props.filters, "store");
  return (
    <View style={{ gap: 8 }}>
      <SearchField value={text} onChangeText={setText} placeholder={f.t("filterSheet.brandSearch")} testID="filter-brand-search" />
      <Text variant="caption" secondary>{f.t("filterSheet.brandNote")}</Text>
      <CapNotice capped={capped} />
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? <Text variant="body" secondary>{f.t("filterSheet.brandNone")}</Text> : null}
        {rows.map((r) => {
          const name = r.unavailable === true && r.name.length === 0 ? f.t("filterSheet.brandUnavailable") : r.name;
          return (
            <Checkbox key={r.id} label={r.count !== undefined ? `${name} (${f.num(r.count)})` : name} value={r.selected} disabled={capped && !r.selected}
              onValueChange={() => props.dispatch({ type: "toggleStore", id: r.id })} />
          );
        })}
      </ScrollView>
    </View>
  );
}

export function PriceBody(props: { draft: ReturnType<typeof useBudgetDraft> }) {
  return <BudgetFields draft={props.draft} />;
}

/** Signed-in only. "setup" mode links to the budget screen; the switch is a request-time filter and says so. */
export function BudgetBody(props: { filters: ListingFilters; mode: "normal" | "setup"; onSetup: () => void; dispatch: Dispatch }) {
  const f = useFormat();
  if (props.mode === "setup") return <ListRow title={f.t("filterSheet.budgetSetup")} onPress={props.onSetup} testID="filter-budget-setup" />;
  return (
    <View style={{ gap: 8 }}>
      <SwitchRow label={f.t("filterSheet.budgetSwitch")} value={props.filters.fitsBudget} onValueChange={(value) => props.dispatch({ type: "setFitsBudget", value })} />
      <Text variant="caption" secondary>{f.t("filterSheet.budgetNote")}</Text>
    </View>
  );
}

export function CategoriesBody(props: { filters: ListingFilters; tree: readonly CategoryNode[]; failed: boolean; dispatch: Dispatch }) {
  const f = useFormat();
  const capped = atFacetCap(props.filters, "category");
  const subtree = categoriesIncludeSubtree(props.filters, props.tree, { world: "everything" });
  return (
    <View style={{ gap: 8 }}>
      <CapNotice capped={capped} />
      {!subtree ? <Text variant="caption" secondary>{f.t("filterSheet.subtreeDropped")}</Text> : null}
      <CategoryPicker tree={props.tree} selected={props.filters.categoryIds} failed={props.failed} maxHeight={240} onToggle={(id) => props.dispatch({ type: "toggleCategory", id })} />
    </View>
  );
}

export function DiscountBody(props: { filters: ListingFilters; dispatch: Dispatch }) {
  const f = useFormat();
  return (
    <View style={{ gap: 8 }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={f.t("filterSheet.sectionDiscount")} style={chipRow}>
        <Chip role="radio" label={f.t("shopFilter.discountAny")} selected={props.filters.minDiscountPct === null} onPress={() => props.dispatch({ type: "setMinDiscount", pct: null })} testID="filter-discount-any" />
        {DISCOUNT_STEPS.map((pct) => (
          <Chip key={pct} role="radio" label={f.t("shopFilter.discountStep", { pct: `${f.num(pct)}%` })} selected={props.filters.minDiscountPct === pct} onPress={() => props.dispatch({ type: "setMinDiscount", pct })} testID={`filter-discount-${pct}`} />
        ))}
      </View>
      <Checkbox label={f.t("shopFilter.lowest30d", { days: f.num(LOWEST_PRICE_DAYS) })} value={props.filters.lowest30d} onValueChange={() => props.dispatch({ type: "toggleFlag", flag: "lowest30d" })} />
      <Text variant="caption" secondary>{f.t("shopFilter.discountNote")}</Text>
    </View>
  );
}

export function MoreBody(props: { filters: ListingFilters; dispatch: Dispatch }) {
  const f = useFormat();
  return (
    <View style={{ gap: 12 }}>
      <Text variant="callout" weight="500">{f.t("filterSheet.moreDepartment")}</Text>
      <View style={chipRow}>
        {AVATAR_DEPARTMENTS.map((d) => (
          <Chip key={d} role="checkbox" label={f.t(`home.dept.${d}`)} selected={props.filters.department === d} onPress={() => props.dispatch({ type: "setDepartment", department: props.filters.department === d ? null : d })} testID={`filter-dept-${d}`} />
        ))}
      </View>
      <Text variant="callout" weight="500">{f.t("filterSheet.moreCondition")}</Text>
      <View style={chipRow}>
        {CONDITIONS.map((c) => (
          <Chip key={c} role="checkbox" label={f.t(`search.condition.${c}`)} selected={props.filters.conditions.includes(c)} onPress={() => props.dispatch({ type: "toggleCondition", condition: c })} testID={`filter-condition-${c}`} />
        ))}
      </View>
      <Text variant="callout" weight="500">{f.t("filterSheet.moreDelivery")}</Text>
      <Checkbox label={f.t("shopFilter.freeDelivery")} value={props.filters.freeDelivery} onValueChange={() => props.dispatch({ type: "toggleFlag", flag: "freeDelivery" })} />
      <Checkbox label={f.t("shopFilter.newArrivals")} value={props.filters.newArrivals} onValueChange={() => props.dispatch({ type: "toggleFlag", flag: "newArrivals" })} />
    </View>
  );
}
