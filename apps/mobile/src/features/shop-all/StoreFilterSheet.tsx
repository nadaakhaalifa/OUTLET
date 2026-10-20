import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Checkbox, Chip, SearchField, Text } from "../../ui";
import { useFormat } from "../home/parts";
import type { StoreSummary } from "../worlds/model";
import { MAX_STORE_FILTER, favouriteIds, filterStoresByQuery, isOnlyMyStores, type Selection, type SelectionAction } from "./model";

/** Searchable multi-select store list. Counts per store are omitted: the API does not provide them. */
export function StorePicker(props: {
  stores: readonly StoreSummary[]; selection: Selection; dispatch: (a: SelectionAction) => void; maxHeight?: number;
}) {
  const f = useFormat();
  const [q, setQ] = useState("");
  const rows = useMemo(() => filterStoresByQuery(props.stores, q), [props.stores, q]);
  const fav = favouriteIds(props.stores);
  const mineOn = isOnlyMyStores(props.selection.ids, props.stores);
  return (
    <View style={{ gap: 8 }}>
      <SearchField value={q} onChangeText={setQ} placeholder={f.t("shopAll.searchStores")} testID="shop-all-store-search" />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Chip label={f.t("shopAll.onlyMine")} icon="star-outline" selected={mineOn} testID="shop-all-only-mine"
          onPress={() => props.dispatch(mineOn ? { type: "clear" } : { type: "set", ids: fav.ids })} />
        <Chip label={f.t("shopAll.selectAll")} onPress={() => props.dispatch({ type: "selectAll", ids: rows.map((s) => s.id) })} testID="shop-all-select-all" />
        <Chip label={f.t("shopAll.clear")} onPress={() => props.dispatch({ type: "clear" })} testID="shop-all-clear" />
      </View>
      {fav.ids.length === 0 ? <Text variant="caption" secondary>{f.t("shopAll.noFavourites")}</Text> : null}
      {props.selection.limitHit ? <Text variant="caption" color="danger">{f.t("shopAll.limit", { max: f.num(MAX_STORE_FILTER) })}</Text> : null}
      <ScrollView style={{ maxHeight: props.maxHeight ?? 340 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? <Text variant="body" secondary>{f.t("shopAll.noStoresFound")}</Text> : null}
        {rows.map((s) => (
          <Checkbox key={s.id} label={s.name} value={props.selection.ids.includes(s.id)} onValueChange={() => props.dispatch({ type: "toggle", id: s.id })} />
        ))}
      </ScrollView>
    </View>
  );
}
