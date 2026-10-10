import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text as RNText, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { minTouchTarget, radius, spacing, typography } from "@outlet/ui-tokens";
import { useTheme } from "../theme";
import { buttonStyle, type ButtonVariant } from "../logic/button";
import { fieldView } from "../logic/field";
import { toneColors, type Tone } from "../logic/palette";
import { accessibleName, joinLabel } from "../logic/a11y";
import { MAX_FONT_SCALE } from "../logic/touch";

export type TextVariant = keyof typeof typography;

/** Text honours dynamic type (allowFontScaling) with a cap, and aligns to start (RTL-safe). */
export function Text(props: { variant?: TextVariant; secondary?: boolean; children: ReactNode; style?: StyleProp<TextStyle>; accessibilityRole?: "header" | "text"; numberOfLines?: number }) {
  const { colors } = useTheme();
  const t = typography[props.variant ?? "body"];
  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessibilityRole={props.accessibilityRole ?? (props.variant === "title" || props.variant === "heading" ? "header" : "text")}
      numberOfLines={props.numberOfLines}
      style={[{ fontSize: t.fontSize, lineHeight: t.lineHeight, fontWeight: t.fontWeight, color: props.secondary ? colors.textSecondary : colors.textPrimary, textAlign: "auto", writingDirection: "auto" }, props.style]}
    >
      {props.children}
    </RNText>
  );
}

export function Button(props: { title: string; onPress: () => void; variant?: ButtonVariant; loading?: boolean; disabled?: boolean; accessibilityLabel?: string; accessibilityHint?: string }) {
  const { colors } = useTheme();
  const name = accessibleName(props.accessibilityLabel, props.title) ?? props.title;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={buttonStyle({ variant: props.variant ?? "primary", loading: props.loading === true, disabled: props.disabled === true, pressed: false }, colors).accessibilityState}
      disabled={props.disabled === true || props.loading === true}
      onPress={props.onPress}
      style={({ pressed }) => {
        const s = buttonStyle({ variant: props.variant ?? "primary", loading: props.loading === true, disabled: props.disabled === true, pressed }, colors);
        return { minHeight: minTouchTarget, minWidth: minTouchTarget, paddingVertical: spacing.md, paddingHorizontal: spacing.xl, borderRadius: radius.md, borderWidth: 1, backgroundColor: s.background, borderColor: s.borderColor, opacity: s.opacity, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: spacing.sm };
      }}
    >
      {({ pressed }) => {
        const s = buttonStyle({ variant: props.variant ?? "primary", loading: props.loading === true, disabled: props.disabled === true, pressed }, colors);
        return (
          <>
            {props.loading === true ? <ActivityIndicator color={s.foreground} /> : null}
            <Text style={{ color: s.foreground, fontWeight: "600" }}>{props.title}</Text>
          </>
        );
      }}
    </Pressable>
  );
}

export function TextField(props: { label: string; value: string; onChangeText: (v: string) => void; error?: string; helper?: string; disabled?: boolean; placeholder?: string; secureTextEntry?: boolean; keyboardType?: "default" | "email-address" | "phone-pad" | "numeric" }) {
  const { colors } = useTheme();
  const v = fieldView({ error: props.error, helper: props.helper, focused: false, disabled: props.disabled === true }, colors);
  return (
    <View style={{ gap: spacing.xs, opacity: v.opacity }}>
      <Text variant="caption" secondary>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        editable={props.disabled !== true}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textSecondary}
        secureTextEntry={props.secureTextEntry}
        keyboardType={props.keyboardType}
        allowFontScaling
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={joinLabel(props.label, v.isError ? props.error : props.helper)}
        accessibilityState={{ disabled: props.disabled === true }}
        style={{ minHeight: minTouchTarget, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: v.isError ? 2 : 1, borderColor: v.borderColor, color: colors.textPrimary, backgroundColor: colors.surface, textAlign: "auto", fontSize: typography.body.fontSize }}
      />
      {v.message !== null ? (
        <RNText accessibilityRole={v.isError ? "alert" : "text"} style={{ color: v.messageColor, fontSize: typography.caption.fontSize, textAlign: "auto" }}>{v.message}</RNText>
      ) : null}
    </View>
  );
}

export function Screen(props: { children: ReactNode; scroll?: boolean }) {
  const { colors } = useTheme();
  const pad = { padding: spacing.lg, gap: spacing.lg } as const;
  return props.scroll === false ? (
    <View style={[{ flex: 1, backgroundColor: colors.background }, pad]}>{props.children}</View>
  ) : (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={pad}>{props.children}</ScrollView>
  );
}

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm }, props.style]}>{props.children}</View>;
}

export function Badge(props: { label: string; tone?: Tone }) {
  const { scheme } = useTheme();
  const t = toneColors(props.tone ?? "info", scheme);
  return (
    <View style={{ alignSelf: "flex-start", paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.pill, backgroundColor: t.background, borderWidth: 1, borderColor: t.border }}>
      <Text variant="caption" style={{ color: t.foreground }}>{props.label}</Text>
    </View>
  );
}

const TONE_PREFIX: Record<Tone, string> = { info: "Info", warning: "Warning", error: "Error" };

/** Banner announces as an alert; tone is conveyed by a text prefix as well as colour. */
export function Banner(props: { tone: Tone; message: string; prefix?: string }) {
  const { scheme } = useTheme();
  const t = toneColors(props.tone, scheme);
  const prefix = props.prefix ?? TONE_PREFIX[props.tone];
  return (
    <View accessibilityRole="alert" accessibilityLabel={joinLabel(prefix, props.message)} style={{ padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderStartWidth: 4, borderColor: t.border, backgroundColor: t.background }}>
      <Text style={{ color: t.foreground }}>{`${prefix}: ${props.message}`}</Text>
    </View>
  );
}

export function EmptyState(props: { title: string; description?: string; actionTitle?: string; onAction?: () => void }) {
  return (
    <View style={{ alignItems: "center", padding: spacing.xxl, gap: spacing.md }}>
      <Text variant="heading" style={{ textAlign: "center" }}>{props.title}</Text>
      {props.description ? <Text secondary style={{ textAlign: "center" }}>{props.description}</Text> : null}
      {props.actionTitle && props.onAction ? <Button title={props.actionTitle} onPress={props.onAction} variant="secondary" /> : null}
    </View>
  );
}

/** Copy is supplied by the caller (i18n). Offline shares the layout with a distinct title. */
export function ErrorState(props: { title: string; description?: string; retryTitle: string; onRetry: () => void; offline?: boolean }) {
  return (
    <View accessibilityRole={props.offline === true ? "summary" : "alert"} style={{ alignItems: "center", padding: spacing.xxl, gap: spacing.md }}>
      <Text variant="heading" style={{ textAlign: "center" }}>{props.title}</Text>
      {props.description ? <Text secondary style={{ textAlign: "center" }}>{props.description}</Text> : null}
      <Button title={props.retryTitle} onPress={props.onRetry} />
    </View>
  );
}

export function LoadingState(props: { label: string }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} accessibilityState={{ busy: true }} style={{ alignItems: "center", padding: spacing.xxl, gap: spacing.md }}>
      <ActivityIndicator color={colors.accent} />
      <Text secondary>{props.label}</Text>
    </View>
  );
}

/** Static placeholder block. No shimmer yet; hidden from screen readers. */
export function Skeleton(props: { width?: number | `${number}%`; height?: number }) {
  const { colors } = useTheme();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: props.width ?? "100%", height: props.height ?? 16, borderRadius: radius.sm, backgroundColor: colors.border }} />;
}

export function ListRow(props: { title: string; subtitle?: string; trailing?: ReactNode; onPress?: () => void; accessibilityHint?: string }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ minHeight: minTouchTarget, paddingVertical: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <View style={{ flex: 1 }}>
        <Text>{props.title}</Text>
        {props.subtitle ? <Text variant="caption" secondary>{props.subtitle}</Text> : null}
      </View>
      {props.trailing}
    </View>
  );
  if (!props.onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={joinLabel(props.title, props.subtitle)} accessibilityHint={props.accessibilityHint} onPress={props.onPress} style={({ pressed }) => ({ backgroundColor: pressed ? colors.surface : "transparent" })}>
      {body}
    </Pressable>
  );
}

function Toggle(props: { kind: "checkbox" | "switch"; label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const box = props.kind === "checkbox";
  return (
    <Pressable
      accessibilityRole={props.kind}
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.value, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={() => props.onValueChange(!props.value)}
      style={{ minHeight: minTouchTarget, flexDirection: "row", alignItems: "center", gap: spacing.md, opacity: props.disabled === true ? 0.4 : 1 }}
    >
      <View style={{ width: box ? 24 : 44, height: 24, borderRadius: box ? radius.sm : radius.pill, borderWidth: 2, borderColor: props.value ? colors.accent : colors.border, backgroundColor: props.value ? colors.accent : "transparent", justifyContent: "center", alignItems: props.value ? "flex-end" : "flex-start", paddingHorizontal: box ? 0 : 2 }}>
        {props.value ? <View style={{ width: box ? 10 : 16, height: box ? 10 : 16, alignSelf: box ? "center" : undefined, borderRadius: box ? 2 : radius.pill, backgroundColor: colors.onAccent }} /> : null}
      </View>
      <View style={{ flex: 1 }}><Text>{props.label}</Text></View>
    </Pressable>
  );
}

export function Checkbox(props: { label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean }) {
  return <Toggle kind="checkbox" {...props} />;
}
export function SwitchRow(props: { label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean }) {
  return <Toggle kind="switch" {...props} />;
}

export function Divider() {
  const { colors } = useTheme();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 1, alignSelf: "stretch", backgroundColor: colors.border }} />;
}
