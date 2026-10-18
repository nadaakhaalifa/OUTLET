import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Accordion, BottomSheet, Button, Checkbox, Radio, type AccordionSection } from "../../ui";
import { useFormat } from "../home/parts";
import { SAVED_SORTS, savedFilterCount, type SavedFilter, type SavedSort } from "./model";

const SORT_KEY: Readonly<Record<SavedSort, string>> = {
  newest: "savedTab.sortNewest", priceLow: "shopAll.sortOption.priceLow", priceHigh: "shopAll.sortOption.priceHigh", priceChanged: "savedTab.sortPriceChanged",
};

export interface SavedFilterSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly sort: SavedSort;
  readonly filter: SavedFilter;
  readonly stores: readonly string[];
  /** The selected list has a budget (enables "in budget"). */
  readonly hasBudget: boolean;
  readonly onApply: (sort: SavedSort, filter: SavedFilter) => void;
}

/** Saved sort and per-list filter. Edits a draft; "Show items" applies it, closing discards it. */
export function SavedFilterSheet(props: SavedFilterSheetProps) {
  const f = useFormat();
  const [sort, setSort] = useState<SavedSort>(props.sort);
  const [flt, setFlt] = useState<SavedFilter>(props.filter);
  useEffect(() => {
    if (props.visible) { setSort(props.sort); setFlt(props.filter); }
  }, [props.visible]);
  const toggleStore = (s: string): void => setFlt((c) => ({ ...c, stores: c.stores.includes(s) ? c.stores.filter((x) => x !== s) : [...c.stores, s] }));
  const sections: AccordionSection[] = [
    {
      id: "sort", title: f.t("filterSheet.sectionSort"), summary: sort !== "newest" ? f.t(SORT_KEY[sort]) : null, testID: "saved-filter-sort",
      content: (
        <View accessibilityRole="radiogroup" accessibilityLabel={f.t("filterSheet.sectionSort")}>
          {SAVED_SORTS.map((s) => <Radio key={s} label={f.t(SORT_KEY[s])} selected={sort === s} onPress={() => setSort(s)} />)}
        </View>
      ),
    },
    ...(props.stores.length > 1 ? [{
      id: "store", title: f.t("filterSheet.sectionBrand"), summary: flt.stores.length > 0 ? f.num(flt.stores.length) : null, testID: "saved-filter-store",
      content: <View>{props.stores.map((s) => <Checkbox key={s} label={s} value={flt.stores.includes(s)} onValueChange={() => toggleStore(s)} />)}</View>,
    }] : []),
    {
      id: "show", title: f.t("savedTab.filterShow"), summary: (flt.availableOnly ? 1 : 0) + (flt.inBudget ? 1 : 0) > 0 ? f.num((flt.availableOnly ? 1 : 0) + (flt.inBudget ? 1 : 0)) : null, testID: "saved-filter-show",
      content: (
        <View>
          <Checkbox label={f.t("savedTab.filterAvailableOnly")} value={flt.availableOnly} onValueChange={(v) => setFlt((c) => ({ ...c, availableOnly: v }))} />
          {props.hasBudget ? <Checkbox label={f.t("savedTab.filterInBudget")} value={flt.inBudget} onValueChange={(v) => setFlt((c) => ({ ...c, inBudget: v }))} /> : null}
        </View>
      ),
    },
  ];
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title={f.t("savedTab.filter")} closeLabel={f.t("filterSheet.close")} maxHeightRatio={0.92}>
      <ScrollView style={{ maxHeight: 460 }} nestedScrollEnabled testID="saved-filter-sheet"><Accordion sections={sections} initialOpen="sort" /></ScrollView>
      <View style={{ gap: 8 }}>
        <Button title={f.t("filterSheet.showItems")} onPress={() => { props.onApply(sort, flt); props.onClose(); }} testID="saved-filter-apply" />
        <Button title={f.t("filterSheet.reset")} variant="ghost" disabled={sort === "newest" && savedFilterCount(flt) === 0} onPress={() => { setSort("newest"); setFlt({ stores: [], availableOnly: false, inBudget: false }); }} testID="saved-filter-reset" />
      </View>
    </BottomSheet>
  );
}
