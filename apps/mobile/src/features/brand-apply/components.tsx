import { useEffect, type ReactNode } from "react";
import { Share, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { Banner, Button, Eyebrow, FadeIn, Icon, IconButton, PressScale, Reveal, Screen, StickyBar, Text, useTheme, type IconName } from "../../ui";
import { radius, shadows } from "@outlet/ui-tokens";
import { localizeDigits } from "../money-display";
import { formatDay } from "../orders/model";
import { errorCodeOf, type ErrorCode, type SlotState, type TimelineState } from "./model";

export function useDigits(): (s: string) => string {
  const { i18n } = useTranslation();
  return (s) => localizeDigits(s, i18n.language === "en" ? "en" : "ar");
}
export function useDay(): (iso: string) => string {
  const d = useDigits();
  return (iso) => formatDay(iso, d);
}

/** Copy goes through the system share sheet (it offers Copy): no clipboard module is installed in this build. */
export async function copyText(text: string): Promise<void> {
  try { await Share.share({ message: text }); } catch { /* dismissed or unavailable: nothing to do */ }
}

/** Quiet teal rule that glides to the current step. Never colour-only: the label says "Step n of m". */
export function StepBar(props: { index: number; total: number }) {
  const { t } = useTranslation();
  const { colors, spacing, isRTL, reduceMotion } = useTheme();
  const d = useDigits();
  const ratio = props.total > 0 ? Math.min(1, Math.max(0, props.index / props.total)) : 0;
  const width = useSharedValue(0);
  const p = useSharedValue(reduceMotion ? ratio : 0);
  useEffect(() => {
    p.value = reduceMotion ? ratio : withTiming(ratio, { duration: 480, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [ratio, reduceMotion, p]);
  const sign = isRTL ? 1 : -1;
  const fill = useAnimatedStyle(() => ({ transform: [{ translateX: sign * (1 - p.value) * width.value }] }));
  const label = t("brandApply.common.stepOf", { n: props.index, total: props.total });
  return (
    <View style={{ gap: spacing.sm }} accessible accessibilityLabel={label}>
      <View
        onLayout={(e) => { width.value = e.nativeEvent.layout.width; }}
        style={{ height: 3, borderRadius: 2, backgroundColor: colors.fill, overflow: "hidden" }}
      >
        <Animated.View style={[{ height: 3, width: "100%", borderRadius: 2, backgroundColor: colors.brand }, fill]} />
      </View>
      <Eyebrow secondary>{d(label)}</Eyebrow>
    </View>
  );
}

/** Small round status chip: icon plus word, tone never colour-only. */
export function StatusChip(props: { label: string; icon?: IconName | undefined; tone?: "neutral" | "good" | "bad" | undefined }) {
  const { colors, spacing } = useTheme();
  const tone = props.tone ?? "neutral";
  const color = tone === "good" ? "savings" : tone === "bad" ? "danger" : "textSecondary";
  const border = tone === "good" ? colors.savings : tone === "bad" ? colors.danger : colors.fill;
  return (
    <View
      accessible accessibilityRole="text" accessibilityLabel={props.label}
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, alignSelf: "flex-start", paddingHorizontal: spacing.sm + 2, minHeight: 28, borderWidth: 1, borderColor: border, backgroundColor: colors.fill, borderRadius: radius.pill }}
    >
      {props.icon !== undefined ? <Icon name={props.icon} size={13} color={color} /> : null}
      <Text variant="caption" weight="500" color={color} accessibilityRole="none">{props.label}</Text>
    </View>
  );
}

export function FlowScreen(props: {
  eyebrow: string; title: string; body?: string | undefined; progress?: { index: number; total: number } | undefined;
  onBack?: (() => void) | undefined; footer?: ReactNode; children?: ReactNode; trailing?: ReactNode; onRefresh?: (() => void) | undefined; refreshing?: boolean | undefined;
}) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <Screen
      onBack={props.onBack}
      backLabel={t("brandApply.common.back")}
      trailing={props.trailing}
      onRefresh={props.onRefresh}
      refreshing={props.refreshing}
      footer={props.footer !== undefined ? <StickyBar>{props.footer}</StickyBar> : undefined}
    >
      <View style={{ gap: spacing.md, paddingTop: spacing.sm }}>
        {props.progress !== undefined ? <StepBar index={props.progress.index} total={props.progress.total} /> : null}
        <Reveal>
          <View style={{ gap: spacing.md, paddingTop: spacing.xl }}>
            <Eyebrow secondary>{props.eyebrow}</Eyebrow>
            <Text variant="display" accessibilityRole="header">{props.title}</Text>
            {props.body !== undefined ? <Text variant="lede" secondary>{props.body}</Text> : null}
          </View>
        </Reveal>
      </View>
      <FadeIn delay={140} style={{ gap: spacing.lg }}>{props.children}</FadeIn>
    </Screen>
  );
}

/** Error line for an action. A session that ended gets a "verify again" button. */
export function ErrorNote(props: { code: ErrorCode | null; onSignIn?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  if (props.code === null) return null;
  return (
    <View style={{ gap: spacing.sm }}>
      <Banner tone="error" message={t(`brandApply.errors.${props.code}`)} />
      {props.code === "session_expired" && props.onSignIn !== undefined ? <Button variant="secondary" title={t("brandApply.errors.signIn")} onPress={props.onSignIn} /> : null}
    </View>
  );
}
export const errorOf = errorCodeOf;

/** Label + value with a copy button (DNS record, setup key, recovery codes). Value is selectable and left-to-right. */
export function CopyField(props: { label: string; value: string; copyLabel: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, ...shadows.card }}>
      <Eyebrow secondary>{props.label}</Eyebrow>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Text variant="callout" selectable numeric style={{ writingDirection: "ltr", /* physical-direction: Latin code, always read left to right */ textAlign: "left" }}>{props.value}</Text>
        </View>
        <IconButton icon="copy-outline" label={`${props.copyLabel}: ${props.label}`} onPress={() => void copyText(props.value)} />
      </View>
    </View>
  );
}

/** Rounded radio row (selection lists): surface card, dark ring when selected. */
export function ChoiceRow(props: { title: string; subtitle?: string | undefined; leading?: ReactNode; selected?: boolean | undefined; onPress: () => void; badge?: string | undefined; testID?: string | undefined }) {
  const { colors, spacing } = useTheme();
  return (
    <PressScale
      onPress={props.onPress}
      testID={props.testID}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected === true }}
      accessibilityLabel={props.subtitle !== undefined ? `${props.title}, ${props.subtitle}` : props.title}
      innerStyle={{ flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 64, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.sm, borderRadius: radius.lg, borderWidth: props.selected === true ? 1.5 : 1, borderColor: props.selected === true ? colors.accent : colors.border, backgroundColor: colors.surface }}
    >
      {props.leading}
      <View style={{ flex: 1 }}>
        <Text variant="headline">{props.title}</Text>
        {props.subtitle !== undefined ? <Text variant="caption" secondary>{props.subtitle}</Text> : null}
      </View>
      {props.badge !== undefined ? <StatusChip label={props.badge} /> : null}
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: props.selected === true ? colors.accent : colors.border, backgroundColor: props.selected === true ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {props.selected === true ? <Icon name="checkmark" size={14} color="onAccent" /> : null}
      </View>
    </PressScale>
  );
}

const SLOT_ICON: Record<SlotState["kind"], IconName> = {
  missing: "add-circle-outline", uploading: "cloud-upload-outline", failed: "alert-circle-outline", uploaded: "checkmark-circle-outline",
  scanning: "shield-checkmark-outline", accepted: "checkmark-circle", rejected: "close-circle-outline", needs_replacement: "refresh-circle-outline",
};
export const slotIcon = (s: SlotState): IconName => SLOT_ICON[s.kind];

/** Timeline step marker. Done = filled ink, current = ring, upcoming = hairline. State is also announced in text. */
export function TimelineDot(props: { state: TimelineState }) {
  const { colors } = useTheme();
  const base = { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: props.state === "upcoming" ? colors.border : colors.accent } as const;
  return <View style={{ ...base, backgroundColor: props.state === "done" ? colors.accent : "transparent" }}>
    {props.state === "current" ? <View style={{ position: "absolute", top: 2, start: 2, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
  </View>;
}
