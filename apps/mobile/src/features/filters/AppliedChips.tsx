import { ScrollView, View } from "react-native";
import { Chip, Text } from "../../ui";
import { pluralKey } from "../../i18n/plural";
import { useFormat } from "../home/parts";
import { categoryName, summarizeBudget, type CategoryNode } from "../shop-all/model";
import type { StoreSummary } from "../worlds/model";
import { appliedChips, type AppliedChip, type ListingFilters } from "./model";

/** Human text of one chip (shared with tests of the sheet). Values come from the loaded data; an unknown id falls back to a neutral word, never the raw id. */
export function useChipLabel(tree: readonly CategoryNode[], stores: readonly StoreSummary[]): (c: AppliedChip, f: ListingFilters) => string {
  const f0 = useFormat();
  return (c, f) => {
    switch (c.key) {
      case "store": return f0.t("filterSheet.chipStore", { name: stores.find((s) => s.id === c.id)?.name ?? f0.t("filterSheet.sectionBrand") });
      case "category": { const n = tree.find((x) => x.id === c.id); return n ? categoryName(n, f0.locale) : f0.t("filterSheet.sectionCategories"); }
      case "price": {
        const s = summarizeBudget({ min: f.priceMin, max: f.priceMax }, f0.money);
        return s.kind === "range" ? f0.t("shopFilter.chipRange", { min: s.min, max: s.max }) : s.kind === "upTo" ? f0.t("shopFilter.chipUpTo", { max: s.max }) : s.kind === "from" ? f0.t("shopFilter.chipFrom", { min: s.min }) : "";
      }
      case "fitsBudget": return f0.t("filterSheet.chipFitsBudget");
      case "discount": return f0.t("filterSheet.chipDiscount", { pct: `${f0.num(c.pct)}%` });
      case "lowest30d": return f0.t("shopFilter.lowest30d", { days: f0.num(30) });
      case "condition": return f0.t(`search.condition.${c.condition}`);
      case "department": return f0.t(`home.dept.${c.department}`);
      case "freeDelivery": return f0.t("shopFilter.freeDelivery");
      case "newArrivals": return f0.t("shopFilter.newArrivals");
      case "sort": return f0.t("filterSheet.chipSort", { name: f0.t(`shopAll.sortOption.${c.sort}`) });
    }
  };
}

/** The screen-level world filter (not part of ListingFilters): shown as a chip while it differs from the default. */
export interface WorldChip {
  readonly active: boolean;
  /** Already-localized value, e.g. "Local". */
  readonly label: string;
  readonly onClear: () => void;
}

/** Row of applied-filter chips under a listing header. Each chip removes one filter. Renders nothing when nothing is applied. */
export function AppliedChips(props: { filters: ListingFilters; tree: readonly CategoryNode[]; stores: readonly StoreSummary[]; onRemove: (c: AppliedChip) => void; fitsBudgetActive?: boolean; world?: WorldChip; testID?: string }) {
  const f = useFormat();
  const label = useChipLabel(props.tree, props.stores);
  const chips = appliedChips(props.filters, { fitsBudgetActive: props.fitsBudgetActive !== false });
  const worldChip = props.world !== undefined && props.world.active ? props.world : null;
  const total = chips.length + (worldChip !== null ? 1 : 0);
  if (total === 0) return null;
  return (
    <View style={{ gap: 4 }} testID={props.testID ?? "applied-chips"} accessibilityLabel={f.t("filterSheet.chipsRegion")}>
      <Text variant="caption" secondary>{f.t(pluralKey("filterSheet.appliedLabel", total), { n: f.num(total) })}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 5 }}>
        {worldChip !== null ? (
          <Chip label={worldChip.label} selected icon="close" accessibilityLabel={f.t("filterSheet.removeChip", { name: worldChip.label })} accessibilitySelected={false} onPress={worldChip.onClear} testID="applied-chip-world" />
        ) : null}
        {chips.map((c, i) => {
          const text = label(c, props.filters);
          return (
            <Chip key={`${c.key}-${i}`} label={text} selected icon="close" accessibilityLabel={f.t("filterSheet.removeChip", { name: text })} accessibilitySelected={false}
              onPress={() => props.onRemove(c)} testID={`applied-chip-${c.key}`} />
          );
        })}
      </ScrollView>
    </View>
  );
}
