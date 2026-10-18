import { useEffect, type ReactNode } from "react";
import { Children } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useRouter, type Href } from "expo-router";
import { motion, radius } from "@outlet/ui-tokens";
import { Eyebrow, Reveal, Screen, Text, useTheme } from "../ui";
import { HeroArt, Wordmark, type HeroVariant } from "../art";
import { stepProgress, type OnboardingStep } from "../features/flow";

/** Thin teal rule that fills to the current step; scaleX transform animation from the inline-start edge, instant under Reduce Motion. */
function ProgressRule(props: { from: number; to: number }) {
  const { colors, reduceMotion, isRTL } = useTheme();
  const v = useSharedValue(reduceMotion ? props.to : props.from);
  useEffect(() => {
    v.value = reduceMotion ? props.to : withTiming(props.to, { duration: motion.hero, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [props.to, reduceMotion, v]);
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: Math.min(1, Math.max(0, v.value)) }] }));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 2, backgroundColor: colors.hairline }}>
      <Animated.View style={[{ height: 2, width: "100%", transformOrigin: isRTL ? "right" : "left", backgroundColor: colors.brand }, fill]} />
    </View>
  );
}

/**
 * Common chrome for onboarding steps: ivory paper, wordmark, tracked progress eyebrow with a thin animated rule,
 * serif display title, lede, staggered content, and the dev-fixture notice.
 * `progress` overrides the auth-step progress (used by the preference steps); `art` adds an edge-to-edge editorial band.
 */
export function StepScaffold(props: {
  step: OnboardingStep;
  noBack?: boolean;
  title: string;
  body?: string;
  art?: HeroVariant;
  artAspect?: number;
  progress?: { current: number; total: number; label: string };
  /** Optional top-end slot (language and theme toggle): mirrors automatically in RTL. */
  topEnd?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { isDark } = useTheme();
  const p = props.progress ?? stepProgress(props.step);
  const showProgress = props.progress !== undefined || props.step !== "done";
  const label = props.progress?.label ?? t("onboarding.progress", { current: p.current, total: p.total });
  const router = useRouter();
  // One step back; the first step (no history) returns to the role choice.
  const back = props.noBack === true ? undefined : () => (router.canGoBack() ? router.back() : router.replace("/role" as Href));
  const kids = Children.toArray(props.children);
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen onBack={back} backLabel={t("common.back")}>
        <Reveal index={0}>
          <View style={{ gap: 12 }}>
            {props.topEnd !== undefined ? <View style={{ alignItems: "flex-end" }}>{props.topEnd}</View> : null}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <Wordmark size={16} tone={isDark ? "dark" : "light"} />
              {showProgress ? <Eyebrow>{label}</Eyebrow> : null}
            </View>
            {showProgress ? <ProgressRule from={Math.max(0, p.current - 1) / p.total} to={p.current / p.total} /> : null}
          </View>
        </Reveal>
        {props.art !== undefined ? (
          <Reveal index={1}>
            <View style={{ borderRadius: radius.lg, overflow: "hidden" }}>
              <HeroArt variant={props.art} aspect={props.artAspect ?? 2.4} />
            </View>
          </Reveal>
        ) : null}
        <Reveal index={2}>
          <View style={{ gap: 12 }}>
            <Text variant="display" accessibilityRole="header">{props.title}</Text>
            {props.body !== undefined ? <Text variant="lede" secondary>{props.body}</Text> : null}
          </View>
        </Reveal>
        {kids.map((k, i) => (
          <Reveal key={i} index={3 + i}>{k}</Reveal>
        ))}
      </Screen>
    </KeyboardAvoidingView>
  );
}
