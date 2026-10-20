import { useEffect } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Eyebrow, FadeIn, Text, successNotice, useTheme } from "../../ui";
import { HeroArt, Monogram } from "../../art";

/**
 * Approval moment: ivory page, rounded art, the monogram settles slowly, a teal rule draws in, the
 * title arrives, and exactly one success haptic fires when the mark lands. Reduce Motion shows the end state.
 */
export function ApprovalCeremony(props: { eyebrow: string; title: string; body: string; cta: string; onOpen: () => void; testID?: string }) {
  const { spacing, colors, reduceMotion, isRTL, radii } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const settle = useSharedValue(reduceMotion ? 1 : 0);
  const rule = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (!reduceMotion) {
      settle.value = withTiming(1, { duration: 720, easing: Easing.bezier(0.22, 1, 0.36, 1) });
      rule.value = withDelay(520, withTiming(1, { duration: 480, easing: Easing.bezier(0.22, 1, 0.36, 1) }));
    }
    const id = setTimeout(() => successNotice(), reduceMotion ? 0 : 720);
    return () => clearTimeout(id);
  }, [reduceMotion, settle, rule]);

  const markStyle = useAnimatedStyle(() => ({ opacity: settle.value, transform: [{ scale: 1.14 - 0.14 * settle.value }] }));
  const ruleStyle = useAnimatedStyle(() => ({ opacity: rule.value, transform: [{ scaleX: rule.value }] }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flex: 1, paddingTop: insets.top + spacing.xl, paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.md, paddingHorizontal: 20 }}>
        <View style={{ flex: 1, justifyContent: "center", gap: spacing.xl }}>
          <View style={{ borderRadius: radii.xl - 4, overflow: "hidden" }}>
            <HeroArt variant="drop" aspect={(width - 40) / 200} />
          </View>
          <Animated.View style={markStyle}><Monogram size={64} /></Animated.View>
          <Animated.View style={[{ width: 40, height: 2, borderRadius: 1, backgroundColor: colors.brand, transformOrigin: isRTL ? "right" : "left" }, ruleStyle]} />
          <FadeIn delay={reduceMotion ? 0 : 640}>
            <View style={{ gap: spacing.md }}>
              <Eyebrow secondary>{props.eyebrow}</Eyebrow>
              <Text variant={props.title.length > 20 ? "display" : "hero"} accessibilityRole="header">{props.title}</Text>
              <Text variant="lede" secondary>{props.body}</Text>
            </View>
          </FadeIn>
        </View>
        <FadeIn delay={reduceMotion ? 0 : 900}>
          <Button title={props.cta} onPress={props.onOpen} {...(props.testID !== undefined ? { testID: props.testID } : {})} />
        </FadeIn>
      </View>
    </View>
  );
}
