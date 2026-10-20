import { useRef } from "react";
import { AccessibilityInfo, View, findNodeHandle } from "react-native";
import { Badge, IconButton } from "../../ui";
import { useFormat } from "../home/parts";

let lastTrigger: View | null = null;

/** Moves screen-reader focus back to the filter icon that opened the sheet (best effort). Called by FilterSheet when it closes. */
export function restoreFilterFocus(): void {
  const node = lastTrigger === null ? null : findNodeHandle(lastTrigger);
  if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
}

/** The one filter icon of a listing, with a count badge. Opens the shared FilterSheet. */
export function FilterButton(props: { count: number; onPress: () => void; testID?: string }) {
  const f = useFormat();
  const label = props.count > 0 ? f.t("filterSheet.openApplied", { count: f.num(props.count) }) : f.t("filterSheet.open");
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <IconButton icon="options-outline" label={label} onPress={() => { lastTrigger = ref.current; props.onPress(); }} testID={props.testID ?? "filter-button"} />
      {props.count > 0 ? <View pointerEvents="none" style={{ position: "absolute", top: 0, end: 0 }}><Badge label={f.num(props.count)} kind="verified" /></View> : null}
    </View>
  );
}
