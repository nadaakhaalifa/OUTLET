import { minTouchTarget } from "@outlet/ui-tokens";
import { PressScale, Text, type TextColor } from "../../ui";

/** Quiet inline action (underlined small text) with a 44pt target, a named role and a soft press. */
export function TextAction(props: { label: string; onPress: () => void; accessibilityLabel?: string; color?: TextColor; disabled?: boolean; testID?: string }) {
  return (
    <PressScale
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      haptic={false}
      hitSlop={6}
      scale={0.98}
      style={{ alignSelf: "flex-start" }}
      innerStyle={{ minHeight: minTouchTarget, justifyContent: "center", opacity: props.disabled === true ? 0.5 : 1 }}
    >
      <Text variant="caption" {...(props.color !== undefined ? { color: props.color } : { secondary: true })} style={{ textDecorationLine: "underline" }}>{props.label}</Text>
    </PressScale>
  );
}
