import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Checkbox, SearchField, Text } from "../../ui";
import { useFormat } from "../home/parts";
import { MAX_CATEGORY_FILTER, categoryName, depthOf, searchCategories, type CategoryNode } from "./model";
import { pluralKey } from "../../i18n/plural";

/** Searchable full category tree; multi-select up to the 30-facet limit. Picking a parent also matches its children. */
export function CategoryPicker(props: {
  tree: readonly CategoryNode[]; selected: readonly string[]; onToggle: (id: string) => void; failed: boolean; maxHeight?: number;
}) {
  const f = useFormat();
  const [q, setQ] = useState("");
  const rows = useMemo(() => searchCategories(props.tree, q), [props.tree, q]);
  const atLimit = props.selected.length >= MAX_CATEGORY_FILTER;
  return (
    <View style={{ gap: 8 }}>
      <SearchField value={q} onChangeText={setQ} placeholder={f.t("shopFilter.categorySearch")} testID="shop-category-search" />
      {props.failed ? <Text variant="caption" secondary>{f.t("shopFilter.categoryUnavailable")}</Text> : null}
      {atLimit ? <Text variant="caption" color="danger">{f.t(pluralKey("shopFilter.categoryLimit", MAX_CATEGORY_FILTER), { max: f.num(MAX_CATEGORY_FILTER) })}</Text> : null}
      <ScrollView style={{ maxHeight: props.maxHeight ?? 340 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? <Text variant="body" secondary>{f.t("shopFilter.categoryNone")}</Text> : null}
        {rows.map((n) => (
          <View key={n.id} style={{ paddingStart: q.length === 0 ? depthOf(props.tree, n.id) * 20 : 0 }}>
            <Checkbox label={categoryName(n, f.locale)} value={props.selected.includes(n.id)} onValueChange={() => props.onToggle(n.id)} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
