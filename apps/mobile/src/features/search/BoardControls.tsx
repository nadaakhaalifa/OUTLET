import { View } from "react-native";
import { radius } from "@outlet/ui-tokens";
import { Icon, PressScale, Text, useTheme } from "../../ui";

/** Board pill: soft fill, dark fill when selected. `fill` stretches it inside a row (segmented tabs). */
export function BoardPill(props: { label: string; selected: boolean; onPress: () => void; role?: "button" | "radio" | "checkbox"; height?: number; fill?: boolean; testID?: string }) {
  const { colors } = useTheme();
  const role = props.role ?? "button";
  const state = role === "checkbox" ? { checked: props.selected } : { selected: props.selected };
  return (
    <PressScale
      accessibilityRole={role} accessibilityState={state} accessibilityLabel={props.label} onPress={props.onPress} testID={props.testID}
      {...(props.fill === true ? { style: { flex: 1 } } : {})}
      innerStyle={{ minHeight: props.height ?? 34, paddingHorizontal: 18, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: props.selected ? colors.accent : colors.fill }}
    >
      <Text variant="caption" weight="500" style={{ color: props.selected ? colors.background : colors.textPrimary }} accessibilityRole="none">{props.label}</Text>
    </PressScale>
  );
}

/** Board dropdown pill: label at start, chevron at end. Opens the filter sheet. */
export function DropdownPill(props: { label: string; onPress: () => void; flex: number; testID?: string }) {
  const { colors } = useTheme();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} testID={props.testID} style={{ flex: props.flex }}
      innerStyle={{ minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.fill }}>
      <Text variant="caption" weight="500" accessibilityRole="none">{props.label}</Text>
      <View><Icon name="chevron-down" size={14} color="textSecondary" /></View>
    </PressScale>
  );
}
