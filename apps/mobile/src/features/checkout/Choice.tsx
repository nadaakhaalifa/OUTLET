import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { minTouchTarget, radius, spacing } from "@outlet/ui-tokens";
import { Text, useTheme } from "../../ui";

/** Selectable row (radio or checkbox semantics) with a 44pt minimum target and a named state. */
export function Choice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  role?: "radio" | "checkbox";
  disabled?: boolean;
  detail?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const role = props.role ?? "radio";
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole={role}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={role === "radio" ? { selected: props.selected, disabled: props.disabled === true } : { checked: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={{
        minHeight: minTouchTarget, justifyContent: "center", padding: spacing.md, borderRadius: radius.md, borderWidth: 1,
        borderColor: props.selected ? colors.accent : colors.border, opacity: props.disabled === true ? 0.6 : 1, gap: spacing.xs,
      }}
    >
      <Text style={{ fontWeight: props.selected ? "700" : "400" }}>{props.label}</Text>
      {props.detail !== undefined ? <View style={{ gap: spacing.xs }}>{props.detail}</View> : null}
    </Pressable>
  );
}
