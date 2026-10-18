import { Pressable, View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Badge, Button, IconButton, StoreName, Text } from "../../ui";
import { pluralKey } from "../../i18n/plural";
import { ItemArt } from "../purchase/ItemArt";
import { useFormat } from "../home/parts";
import type { SavedRowView } from "./model";

export const THUMB_W = 72;

export interface SavedRowProps {
  readonly view: SavedRowView;
  readonly listTitle: string;
  /** Offline keeps the cached list readable but turns remove and add off. */
  readonly offline: boolean;
  readonly onRemove: () => void;
  readonly onAddToBag: () => void;
  readonly onRemind: () => void;
  readonly onFindSimilar: () => void;
  readonly onViewBag: () => void;
  readonly onOpen: () => void;
}

/** Compact saved row: 72 pt thumbnail, store name, 2-line title, price, state badge, heart (remove) and one action button. */
export function SavedRow(props: SavedRowProps) {
  const f = useFormat();
  const { item, badge, dimmed, price, priceLine, action } = props.view;
  const offline = props.offline;
  const actionButton = (() => {
    switch (action.kind) {
      case "addToBag":
        return <Button density="compact" title={f.t("savedTab.addToBag")} accessibilityLabel={f.t("savedTab.addToBagName", { title: item.title })} disabled={offline} onPress={props.onAddToBag} testID={`saved-add-${item.id}`} />;
      case "remindTomorrow":
        return <Button density="compact" variant="secondary" title={f.t("wishlists.remindTomorrow")} accessibilityLabel={f.t("wishlists.remindTomorrowName", { title: item.title })} disabled={offline} onPress={props.onRemind} testID={`saved-remind-${item.id}`} />;
      case "waiting":
        return <Button density="compact" variant="secondary" disabled title={f.t(pluralKey("savedTab.availableIn", action.hours), { n: f.num(action.hours) })} onPress={() => undefined} />;
      case "findSimilar":
        return <Button density="compact" variant="secondary" title={f.t("wishlists.findSimilar")} accessibilityLabel={f.t("wishlists.findSimilarName", { title: item.title })} onPress={props.onFindSimilar} testID={`saved-similar-${item.id}`} />;
      case "viewBag":
        return <Button density="compact" variant="secondary" title={f.t("savedTab.viewBag")} onPress={props.onViewBag} testID={`saved-viewbag-${item.id}`} />;
    }
  })();
  return (
    <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }} testID={`saved-row-${item.id}`}>
      <Pressable style={{ opacity: dimmed ? 0.5 : 1 }} accessibilityRole="button" accessibilityLabel={item.title} onPress={props.onOpen}>
        <ItemArt title={item.title} seed={item.productId} width={THUMB_W} label={item.title} />
      </Pressable>
      <View style={{ flex: 1, gap: spacing.xs }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            {item.storeName !== null ? <StoreName name={item.storeName} verified={item.storeVerified} layout="row" /> : null}
            <Text variant="callout" numberOfLines={2} style={{ opacity: dimmed ? 0.6 : 1 }}>{item.title}</Text>
          </View>
          <IconButton icon="heart" label={f.t("savedTab.removeItem", { title: item.title, list: props.listTitle })} onPress={props.onRemove} disabled={offline} size={20} testID={`saved-remove-${item.id}`} />
        </View>
        {price !== null ? <Text variant="callout" numeric weight="600">{f.money(price)}</Text> : null}
        {priceLine !== null ? (
          <Text variant="caption" color={priceLine.lower ? "savings" : "textSecondary"}>{f.t("savedTab.wasNow", { was: f.money(priceLine.was), now: f.money(priceLine.now) })}</Text>
        ) : null}
        {badge !== null ? <Badge kind={badge === "inBag" ? "verified" : "neutral"} label={f.t(badge === "inBag" ? "savedTab.inBag" : "savedTab.noLongerAvailable")} /> : null}
        <View style={{ alignSelf: "flex-start", paddingTop: spacing.xs }}>{actionButton}</View>
      </View>
    </View>
  );
}
