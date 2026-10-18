import { useEffect, type ReactNode } from "react";
import { Pressable, Text as RNText, View, type AccessibilityRole, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { motion, type ColorTokens, type FontWeight, type TypeVariant } from "@outlet/ui-tokens";
import { useTheme } from "../theme";
import { MAX_FONT_SCALE } from "../logic/touch";
import { bezier, pressFeedback } from "../logic/motion";
import { textWritingDirection } from "../logic/rtl";

export type IconName = keyof typeof Ionicons.glyphMap;
export type TextColor = keyof ColorTokens;
export type TextVariant = TypeVariant;

/** Fire-and-forget light haptic; never throws (simulators, unsupported devices). */
export function lightImpact(): void {
  try { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined); } catch { /* unsupported */ }
}

/** Selection tick for toggles, tabs and segmented controls. */
export function selectionTick(): void {
  try { void Haptics.selectionAsync().catch(() => undefined); } catch { /* unsupported */ }
}

/** Success notification haptic for completed actions (order placed, saved). */
export function successNotice(): void {
  try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined); } catch { /* unsupported */ }
}

export interface TextProps {
  variant?: TextVariant | undefined;
  secondary?: boolean | undefined;
  /** Semantic colour role. Wins over `secondary`. */
  color?: TextColor | undefined;
  weight?: FontWeight | undefined;
  /** Tabular numerals; use for prices and quantities. */
  numeric?: boolean | undefined;
  align?: "start" | "center" | "end" | undefined;
  children: ReactNode;
  style?: StyleProp<TextStyle> | undefined;
  accessibilityRole?: AccessibilityRole | undefined;
  numberOfLines?: number | undefined;
  testID?: string | undefined;
  selectable?: boolean | undefined;
  /** Lower the Dynamic Type cap for fixed-height chrome (tab bar). Defaults to the kit maximum. */
  maxScale?: number | undefined;
}

/** Honours Dynamic Type (capped), loaded fonts, Arabic metrics and RTL. Aligns to start unless told otherwise. */
export function Text(props: TextProps) {
  const { colors, type, isRTL } = useTheme();
  const variant = props.variant ?? "body";
  const color = props.color !== undefined ? colors[props.color] : props.secondary === true ? colors.textSecondary : colors.textPrimary;
  const role = props.accessibilityRole ?? (variant === "display" || variant === "title1" || variant === "title" || variant === "title2" || variant === "heading" ? "header" : "text");
  // textAlign "auto" follows the text's own script; explicit start/end follow layout direction.
  // physical-direction: RN textAlign has no start/end value, so the logical edge is mapped from the app direction here.
  const textAlign: TextStyle["textAlign"] = props.align === "center" ? "center" : props.align === "end" ? (isRTL ? "left" : "right") : props.align === "start" ? (isRTL ? "right" : "left") : "auto";
  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={Math.min(props.maxScale ?? MAX_FONT_SCALE, MAX_FONT_SCALE)}
      accessibilityRole={role}
      numberOfLines={props.numberOfLines}
      testID={props.testID}
      selectable={props.selectable}
      style={[type(variant, { numeric: props.numeric, weight: props.weight }), { color, textAlign, writingDirection: typeof props.children === "string" ? textWritingDirection(props.children, isRTL) : isRTL ? "rtl" : "ltr" }, props.style, hasArabic(props.children) ? NO_TRACKING : null]}
    >
      {typeof props.children === "string" ? keepBrandTogether(props.children) : props.children}
    </RNText>
  );
}

const NO_TRACKING: TextStyle = { letterSpacing: 0 };
/** Tracking breaks Arabic joining (letters read as stretched kashida), so any Arabic string is never letter-spaced. */
function hasArabic(children: ReactNode): boolean {
  return typeof children === "string" && /[\u0600-\u06FF]/.test(children);
}

/** Word joiners stop "Z-OUTLET" from breaking at the hyphen (Latin and Arabic lines alike). */
function keepBrandTogether(s: string): string {
  return s.includes("Z-OUTLET") ? s.replace(/Z-OUTLET/g, "Z\u2060-\u2060OUTLET") : s;
}

/** Small uppercase label with wide tracking (Latin only; Arabic is untracked and not uppercased). */
export function Eyebrow(props: { children: ReactNode; secondary?: boolean | undefined; color?: TextColor | undefined; style?: StyleProp<TextStyle> | undefined; numberOfLines?: number | undefined }) {
  return <Text variant="eyebrow" secondary={props.secondary ?? true} color={props.color} style={props.style} numberOfLines={props.numberOfLines} accessibilityRole="text">{props.children}</Text>;
}

/** Pressable with a damped spring scale and a faint opacity dip. Reduce Motion drops the scale (opacity dip only). */
export function PressScale(props: {
  onPress?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  disabled?: boolean | undefined;
  haptic?: boolean | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  innerStyle?: StyleProp<ViewStyle> | undefined;
  children: ReactNode;
  accessibilityRole?: AccessibilityRole | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  accessibilityState?: { disabled?: boolean; busy?: boolean; selected?: boolean; checked?: boolean; expanded?: boolean } | undefined;
  hitSlop?: number | undefined;
  testID?: string | undefined;
  scale?: number | undefined;
  /** Called with true on press-in and false on press-out, for pressed-state colour changes. */
  onPressedChange?: ((pressed: boolean) => void) | undefined;
}) {
  const { reduceMotion } = useTheme();
  const s = useSharedValue(1);
  const o = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ scale: s.value }] }));
  const fb = pressFeedback(reduceMotion, props.scale);
  return (
    <Animated.View style={[props.style, anim]}>
      <Pressable
        testID={props.testID}
        disabled={props.disabled}
        hitSlop={props.hitSlop}
        accessibilityRole={props.accessibilityRole}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={props.accessibilityState}
        onHoverIn={() => { o.value = withTiming(0.88, { duration: motion.instant }); }}
        onHoverOut={() => { o.value = withTiming(1, { duration: motion.fast }); }}
        onPressIn={() => {
          props.onPressedChange?.(true);
          o.value = withTiming(fb.opacity, { duration: motion.instant });
          if (!reduceMotion) s.value = withSpring(fb.scale, motion.springs.press);
        }}
        onPressOut={() => {
          props.onPressedChange?.(false);
          o.value = withTiming(1, { duration: motion.fast });
          s.value = withSpring(1, motion.springs.settle);
        }}
        onPress={() => { if (props.haptic !== false) lightImpact(); props.onPress?.(); }}
        onLongPress={props.onLongPress}
        style={props.innerStyle}
      >
        {props.children}
      </Pressable>
    </Animated.View>
  );
}

/** Icon that flips in RTL when `directional`. `size` is PHYSICAL points: scale a raw number with `s(n)` (the default 20 is already zoomed). */
export function Icon(props: { name: IconName; size?: number | undefined; color?: TextColor | undefined; directional?: boolean | undefined }) {
  const { colors, isRTL, sc } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={props.directional === true && isRTL ? { transform: [{ scaleX: -1 }] } : undefined}>
      <Ionicons name={props.name} size={props.size ?? sc(20)} color={colors[props.color ?? "textPrimary"]} />
    </View>
  );
}

/** 1px hairline. */
export function Divider(props: { inset?: number | undefined; style?: StyleProp<ViewStyle> | undefined }) {
  const { colors } = useTheme();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ height: 1, alignSelf: "stretch", backgroundColor: colors.hairline, marginStart: props.inset ?? 0 }, props.style]} />;
}

/** Fades (and lifts 8pt) children in once on mount: slow, deliberate reveal. Reduce Motion renders immediately. */
export function FadeIn(props: { children: ReactNode; delay?: number | undefined; style?: StyleProp<ViewStyle> | undefined }) {
  const { reduceMotion } = useTheme();
  const t = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) return;
    const [a, b, c, d] = bezier("standard");
    t.value = withDelay(props.delay ?? 0, withTiming(1, { duration: motion.slow, easing: Easing.bezier(a, b, c, d) }));
  }, [t, reduceMotion, props.delay]);
  const st = useAnimatedStyle(() => ({ opacity: t.value, transform: [{ translateY: (1 - t.value) * 8 }] }));
  return <Animated.View style={[props.style, st]}>{props.children}</Animated.View>;
}
