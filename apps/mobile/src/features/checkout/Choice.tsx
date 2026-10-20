import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { minTouchTarget, radius, spacing } from "@outlet/ui-tokens";
import { Icon, Reveal, Text, selectionTick, useTheme } from "../../ui";

/** Selectable hairline row (radio or checkbox semantics): ink indicator at the start, 44pt target, named state. */
export function Choice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  role?: "radio" | "checkbox";
  disabled?: boolean;
  detail?: ReactNode;
  trailing?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const role = props.role ?? "radio";
  const box = role === "checkbox";
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole={role}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={box ? { checked: props.selected, disabled: props.disabled === true } : { selected: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={() => { if (!props.selected || box) selectionTick(); props.onPress(); }}
      style={{
        minHeight: minTouchTarget + 8, flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: spacing.md,
        borderBottomWidth: 1, borderBottomColor: colors.hairline, opacity: props.disabled === true ? 0.55 : 1,
      }}
    >
      <View
        style={{
          width: 20, height: 20, marginTop: 2, borderWidth: 1, borderColor: props.selected ? colors.accent : colors.textSecondary,
          borderRadius: box ? radius.xs + 2 : radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: props.selected && box ? colors.accent : "transparent",
        }}
      >
        {props.selected && box ? <Icon name="checkmark" size={14} color="onAccent" /> : null}
        {props.selected && !box ? <Reveal><View style={{ width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.accent }} /></Reveal> : null}
      </View>
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="callout" weight={props.selected ? "500" : "400"}>{props.label}</Text>
        {props.detail !== undefined ? <View style={{ gap: spacing.xs }}>{props.detail}</View> : null}
      </View>
      {props.trailing}
    </Pressable>
  );
}
