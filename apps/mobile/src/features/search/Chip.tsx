import { Pressable } from "react-native";
import { minTouchTarget, radius, spacing } from "@outlet/ui-tokens";
import { Text, useTheme } from "../../ui";

/** 44pt chip used by search, product page, wishlists and size profile. Selected state is announced. */
export function Chip(props: { label: string; selected: boolean; onPress: () => void; role?: "radio" | "button" | "checkbox"; disabled?: boolean; accessibilityLabel?: string; testID?: string }) {
  const { colors } = useTheme();
  const role = props.role ?? "button";
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole={role}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={role === "checkbox" ? { checked: props.selected, disabled: props.disabled === true } : { selected: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={{
        minHeight: minTouchTarget, minWidth: minTouchTarget, justifyContent: "center", paddingHorizontal: spacing.md,
        borderRadius: radius.pill, borderWidth: 1, opacity: props.disabled === true ? 0.5 : 1,
        borderColor: props.selected ? colors.accent : colors.border,
        backgroundColor: props.selected ? colors.accent : "transparent",
      }}
    >
      <Text style={{ color: props.selected ? colors.onAccent : colors.textPrimary, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}
