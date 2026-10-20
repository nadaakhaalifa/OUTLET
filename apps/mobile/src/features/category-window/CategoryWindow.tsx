import { View } from "react-native";
import { BottomSheet, Button, ListRow, Skeleton, Text } from "../../ui";
import { pluralKey } from "../../i18n/plural";
import { useFormat } from "../home/parts";
import { categoryName, type CategoryNode } from "../shop-all/model";
import { windowRows, type CategoryCounts, type WindowRow } from "./model";

export interface CategoryWindowProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly node: CategoryNode | null;
  readonly tree: readonly CategoryNode[];
  readonly treeLoading: boolean;
  readonly treeFailed: boolean;
  readonly onRetry: () => void;
  /** API counts for the current world and store scope; omit until the server sends them. */
  readonly counts?: CategoryCounts | undefined;
  /** Called with the chosen node (the opened category for "See all", or a child). */
  readonly onSelect: (target: CategoryNode, row: "all" | "child", hasCount: boolean) => void;
}

/** Bottom sheet of subcategories. A number is rendered only when the API gave one; a confirmed 0 disables the row. */
export function CategoryWindow(props: CategoryWindowProps) {
  const f = useFormat();
  const node = props.node;
  const rows: readonly WindowRow[] = node === null ? [] : windowRows(props.tree, node, props.counts);
  const name = node === null ? "" : categoryName(node, f.locale);
  return (
    <BottomSheet visible={props.visible && node !== null} onClose={props.onClose} title={name} closeLabel={f.t("categoryWindow.close")}>
      <View testID="category-window">
        {props.treeLoading ? (
          <View style={{ gap: 12 }} accessibilityLabel={f.t("categoryWindow.loading")}>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={44} />)}
          </View>
        ) : null}
        {!props.treeLoading && node !== null ? rows.map((r) => {
          if (r.kind === "all") {
            return <ListRow key={r.id} title={f.t("categoryWindow.seeAll", { name })} {...(r.count !== undefined ? { value: f.num(r.count) } : {})} onPress={() => props.onSelect(node, "all", r.count !== undefined)} divider testID="category-window-all" />;
          }
          const childName = categoryName(r.node, f.locale);
          if (r.disabled) {
            return (
              <View key={r.id} accessible accessibilityState={{ disabled: true }} accessibilityLabel={`${childName}. ${f.t("categoryWindow.empty")}`} style={{ opacity: 0.5, paddingVertical: 12, gap: 2 }} testID={`category-window-${r.id}`}>
                <Text variant="body" accessibilityRole="none">{childName}</Text>
                <Text variant="caption" secondary accessibilityRole="none">{f.t("categoryWindow.empty")}</Text>
              </View>
            );
          }
          return (
            <ListRow key={r.id} title={childName} {...(r.count !== undefined ? { value: f.num(r.count) } : {})} onPress={() => props.onSelect(r.node, "child", r.count !== undefined)} divider
              {...(r.count !== undefined ? { accessibilityHint: f.t(pluralKey("categoryWindow.countLabel", r.count), { name: childName, n: f.num(r.count) }) } : {})} testID={`category-window-${r.id}`} />
          );
        }) : null}
        {props.treeFailed && !props.treeLoading ? (
          <View style={{ gap: 8, paddingTop: 8 }}>
            <Text variant="caption" color="danger">{f.t("categoryWindow.failed")}</Text>
            <Button title={f.t("categoryWindow.retry")} variant="secondary" onPress={props.onRetry} testID="category-window-retry" />
          </View>
        ) : null}
      </View>
    </BottomSheet>
  );
}
