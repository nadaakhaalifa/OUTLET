import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, TextInput, View, type LayoutChangeEvent } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { brand, minTouchTarget, motion, radius, slopFor } from "@outlet/ui-tokens";
import { useTheme } from "../theme";
import { buttonStyle, type ButtonVariant } from "../logic/button";
import { fieldView } from "../logic/field";
import { accessibleName, joinLabel } from "../logic/a11y";
import { MAX_FONT_SCALE } from "../logic/touch";
import { inlineSign } from "../logic/rtl";
import { progressRatio, sizeCellView, stepQuantity } from "../logic/misc";
import { Icon, PressScale, Text, selectionTick, type IconName } from "./primitives";
import { IconButton } from "./glass";

/** v2: rounded 14, sentence case Inter 600 callout (14pt). Primary = deep teal-black. `onImage` = light ivory pill for photos. Density v2: 44pt tall (compact 40 visual + hitSlop = 44). */
export function Button(props: { density?: Density | undefined; title: string; onPress: () => void; variant?: ButtonVariant | undefined; loading?: boolean | undefined; disabled?: boolean | undefined; accessibilityLabel?: string | undefined; accessibilityHint?: string | undefined; icon?: IconName | undefined; fullWidth?: boolean | undefined; onImage?: boolean | undefined; testID?: string | undefined }) {
  const { colors, s, sc, controls, radii } = useTheme();
  const variant = props.variant ?? "primary";
  const base = buttonStyle({ variant, loading: props.loading === true, disabled: props.disabled === true, pressed: false }, colors);
  // onImage: for buttons placed on a hero/scrim. Primary becomes a light ivory pill; others use white outline/text.
  const onImage = props.onImage === true;
  const st = !onImage ? base : variant === "primary" || variant === "brand"
    ? { ...base, background: brand.ivory, foreground: brand.ink, borderColor: brand.ivory }
    : { ...base, foreground: colors.onImage, borderColor: variant === "ghost" ? "transparent" : colors.onImage };
  const name = accessibleName(props.accessibilityLabel, props.title) ?? props.title;
  return (
    <PressScale
      testID={props.testID}
      onPress={() => { if (st.interactive) props.onPress(); }}
      disabled={!st.interactive}
      haptic={st.interactive}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={st.accessibilityState}
      style={{ opacity: st.opacity, alignSelf: props.fullWidth === false ? "flex-start" : "stretch" }}
      hitSlop={props.density === "compact" ? slopFor(controls.buttonCompact) : undefined}
      innerStyle={{ minHeight: props.density === "compact" ? controls.buttonCompact : controls.button, minWidth: minTouchTarget, paddingHorizontal: s(20), borderRadius: onImage ? radii.pill : radii.md, borderWidth: 1, backgroundColor: st.background, borderColor: st.borderColor, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: s(8) }}
    >
      {props.loading === true ? <ActivityIndicator color={st.foreground} /> : props.icon !== undefined ? <Icon name={props.icon} size={sc(16)} color={variant === "primary" ? "onAccent" : variant === "brand" ? "onBrand" : variant === "destructive" ? "onDanger" : "textPrimary"} /> : null}
      <Text variant="callout" weight="600" style={{ color: st.foreground }} accessibilityRole="none">{props.title}</Text>
    </PressScale>
  );
}

/**
 * Form control system. Label sits ABOVE a 46pt (compact 44pt) rounded-14 control with a visible 1px outline (`fieldBorder`, >= 3:1),
 * a 2pt brand focus ring, and helper/error text below (error carries an icon, never colour-only). `suffix` renders
 * a trailing unit (e.g. EGP); `required` adds a marker that is also spoken. Every field is the same height.
 */
export type Density = "compact" | "comfortable";
/** `roomy` is deprecated: it maps to comfortable. */
export function densityOf(p: { density?: Density | undefined; roomy?: boolean | undefined }): Density { return p.density ?? "comfortable"; }

export function TextField(props: { density?: Density | undefined; roomy?: boolean | undefined; label: string; value: string; onChangeText: (v: string) => void; error?: string | undefined; helper?: string | undefined; disabled?: boolean | undefined; placeholder?: string | undefined; secureTextEntry?: boolean | undefined; keyboardType?: "default" | "email-address" | "phone-pad" | "numeric" | undefined; testID?: string | undefined; maxLength?: number | undefined; autoFocus?: boolean | undefined; leadingIcon?: IconName | undefined; suffix?: string | undefined; required?: boolean | undefined; requiredLabel?: string | undefined; multiline?: boolean | undefined; onLayout?: ((e: LayoutChangeEvent) => void) | undefined; leading?: ReactNode | undefined; trailing?: ReactNode | undefined }) {
  const { colors, type, s, sc, controls, radii, sized } = useTheme();
  const [focused, setFocused] = useState(false);
  const v = fieldView({ error: props.error, helper: props.helper, focused, disabled: props.disabled === true }, colors);
  const ring = focused || v.isError;
  const compact = densityOf(props) === "compact";
  const labelStyle = compact ? sized(12, 16) : sized(13, 18);
  return (
    <View onLayout={props.onLayout} style={{ gap: s(6), opacity: v.opacity }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: s(6) }}>
        <Text variant="callout" weight="500" style={labelStyle} accessibilityRole="none">{props.label}</Text>
        {props.required === true ? <Text variant="callout" weight="600" color="danger" style={labelStyle} accessibilityRole="none">*</Text> : null}
      </View>
      <View style={{ minHeight: props.multiline === true ? (compact ? s(84) : s(104)) : compact ? controls.fieldCompact : controls.field, flexDirection: "row", alignItems: props.multiline === true ? "flex-start" : "center", gap: s(8), paddingStart: props.leading !== undefined ? s(8) : s(12), paddingEnd: props.trailing !== undefined ? s(8) : s(12), borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: ring ? 2 : 1, borderColor: v.isError ? colors.danger : focused ? colors.brand : colors.fieldBorder }}>
        {props.leading !== undefined ? <View style={{ alignSelf: "center" }}>{props.leading}</View> : null}
        {props.leadingIcon !== undefined ? <Icon name={props.leadingIcon} size={sc(18)} color="textSecondary" /> : null}
        <TextInput
          testID={props.testID}
          value={props.value}
          onChangeText={props.onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={props.disabled !== true}
          placeholder={props.placeholder}
          placeholderTextColor={colors.textSecondary}
          secureTextEntry={props.secureTextEntry}
          keyboardType={props.keyboardType}
          maxLength={props.maxLength}
          autoFocus={props.autoFocus}
          multiline={props.multiline}
          allowFontScaling
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          accessibilityLabel={joinLabel(props.required === true && props.requiredLabel !== undefined ? `${props.label}, ${props.requiredLabel}` : props.label, v.isError ? props.error : props.helper)}
          accessibilityState={{ disabled: props.disabled === true }}
          selectionColor={colors.textPrimary}
          style={[type(compact ? "callout" : "body"), { flex: 1, paddingVertical: props.multiline === true ? (compact ? s(10) : s(12)) : 0, minHeight: props.multiline === true ? (compact ? s(72) : s(90)) : compact ? controls.fieldCompact - 2 : controls.field - 2, color: colors.textPrimary, textAlign: "auto", textAlignVertical: props.multiline === true ? "top" : "center" }]}
        />
        {props.suffix !== undefined ? <Text variant="callout" weight="500" secondary accessibilityRole="none">{props.suffix}</Text> : null}
        {props.trailing !== undefined ? <View style={{ alignSelf: "center" }}>{props.trailing}</View> : null}
      </View>
      {v.message !== null ? (
        <View accessibilityRole={v.isError ? "alert" : "text"} style={{ flexDirection: "row", alignItems: "flex-start", gap: s(6) }}>
          <Icon name={v.isError ? "alert-circle-outline" : "information-circle-outline"} size={sc(15)} color={v.isError ? "danger" : "textSecondary"} />
          <Text variant="caption" style={{ color: v.messageColor, flex: 1 }} accessibilityRole="none">{v.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Amount field with a unit suffix (default EGP) and a numeric keypad. Same control, same height as TextField. */
export function NumberField(props: Omit<Parameters<typeof TextField>[0], "keyboardType" | "suffix"> & { unit?: string | undefined }) {
  const { unit, ...rest } = props;
  return <TextField {...rest} keyboardType="numeric" suffix={unit ?? "EGP"} />;
}

/** Label + wrapping chip group (never scrolls sideways, never clips). Single or multi select is the caller's choice. */
export function ChipGroup(props: { density?: Density | undefined; roomy?: boolean | undefined; label?: string | undefined; required?: boolean | undefined; error?: string | undefined; helper?: string | undefined; children: ReactNode; onLayout?: ((e: LayoutChangeEvent) => void) | undefined }) {
  const { s, sc, sized } = useTheme();
  const compact = densityOf(props) === "compact";
  const labelStyle = compact ? sized(12, 16) : sized(13, 18);
  return (
    <View onLayout={props.onLayout} style={{ gap: s(6) }}>
      {props.label !== undefined ? (
        <View style={{ flexDirection: "row", gap: s(6) }}>
          <Text variant="callout" weight="500" style={labelStyle} accessibilityRole="none">{props.label}</Text>
          {props.required === true ? <Text variant="callout" weight="600" color="danger" style={labelStyle} accessibilityRole="none">*</Text> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: s(8) }}>{props.children}</View>
      {props.error !== undefined ? (
        <View accessibilityRole="alert" style={{ flexDirection: "row", gap: s(6), alignItems: "flex-start" }}>
          <Icon name="alert-circle-outline" size={sc(15)} color="danger" />
          <Text variant="caption" color="danger" style={{ flex: 1 }} accessibilityRole="none">{props.error}</Text>
        </View>
      ) : props.helper !== undefined ? <Text variant="caption" secondary>{props.helper}</Text> : null}
    </View>
  );
}

/**
 * Flat form section: title (+ optional done tick and trailing action), a hairline, then the content on a 14pt gap.
 * No box. Sections are separated by 24pt of rhythm from the parent's gap. `collapsed` hides the content, keeping the header.
 */
export function FormSection(props: { title: string; description?: string | undefined; done?: boolean | undefined; doneLabel?: string | undefined; collapsed?: boolean | undefined; onToggle?: (() => void) | undefined; trailing?: ReactNode; children: ReactNode; onLayout?: ((e: LayoutChangeEvent) => void) | undefined; testID?: string | undefined }) {
  const { colors, s, sc } = useTheme();
  const collapsed = props.collapsed === true;
  const head = (
    <View style={{ minHeight: sc(44), flexDirection: "row", alignItems: "center", gap: s(10) }}>
      {props.done !== undefined ? (
        <View accessible accessibilityLabel={props.done ? props.doneLabel : undefined} style={{ width: s(22), height: s(22), borderRadius: s(11), alignItems: "center", justifyContent: "center", backgroundColor: props.done ? colors.savings : "transparent", borderWidth: props.done ? 0 : 1.5, borderColor: colors.fieldBorder }}>
          {props.done ? <Icon name="checkmark" size={sc(14)} color="onSavings" /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1 }}><Text variant="headline" weight="600" accessibilityRole="header">{props.title}</Text></View>
      {props.trailing}
      {props.onToggle !== undefined ? <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={sc(18)} color="textSecondary" /> : null}
    </View>
  );
  return (
    <View testID={props.testID} onLayout={props.onLayout} style={{ gap: s(14) }}>
      <View>
        {props.onToggle !== undefined
          ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed }} accessibilityLabel={props.title} onPress={() => { selectionTick(); props.onToggle?.(); }}>{head}</Pressable>
          : head}
        <View style={{ height: 1, backgroundColor: colors.hairline }} />
      </View>
      {collapsed ? null : (
        <>
          {props.description !== undefined ? <Text variant="caption" secondary>{props.description}</Text> : null}
          <View style={{ gap: s(14) }}>{props.children}</View>
        </>
      )}
    </View>
  );
}

export interface StepItem { readonly id: string; readonly label: string; readonly done: boolean; readonly active: boolean }

/** Compact step indicator: numbered circle (tick when complete, ring when current) over a 2-line label. Taps jump to the section. */
export function StepIndicator(props: { steps: readonly StepItem[]; onPress: (id: string) => void; doneLabel: string; testID?: string | undefined }) {
  const { colors, s, sc } = useTheme();
  return (
    <View testID={props.testID} accessibilityRole="tablist" style={{ flexDirection: "row", gap: s(4) }}>
      {props.steps.map((st, i) => (
        <Pressable key={st.id} accessibilityRole="tab" accessibilityState={{ selected: st.active }} accessibilityLabel={st.done ? `${st.label}, ${props.doneLabel}` : st.label} onPress={() => { selectionTick(); props.onPress(st.id); }} style={{ flex: 1, minHeight: sc(minTouchTarget), alignItems: "center", gap: s(4), paddingVertical: s(4) }}>
          <View style={{ width: s(26), height: s(26), borderRadius: s(13), alignItems: "center", justifyContent: "center", backgroundColor: st.done ? colors.savings : st.active ? colors.accent : "transparent", borderWidth: st.done || st.active ? 0 : 1.5, borderColor: colors.fieldBorder }}>
            {st.done ? <Icon name="checkmark" size={sc(15)} color="onSavings" /> : <Text variant="caption" weight="600" color={st.active ? "onAccent" : "textSecondary"} accessibilityRole="none">{String(i + 1)}</Text>}
          </View>
          <Text variant="caption" weight={st.active ? "600" : "400"} secondary={!st.active} align="center" numberOfLines={2} accessibilityRole="none">{st.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Row(props: { selected: boolean; disabled?: boolean | undefined; role: "checkbox" | "switch" | "radio"; label: string; onPress: () => void; control: ReactNode }) {
  const { s, sc } = useTheme();
  return (
    <Pressable
      accessibilityRole={props.role}
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={() => { selectionTick(); props.onPress(); }}
      style={{ minHeight: sc(minTouchTarget), flexDirection: "row", alignItems: "center", gap: s(12), opacity: props.disabled === true ? 0.4 : 1 }}
    >
      <View style={{ flex: 1 }}><Text variant="body">{props.label}</Text></View>
      {props.control}
    </Pressable>
  );
}

export function Checkbox(props: { label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean | undefined }) {
  const { colors, s, sc } = useTheme();
  return (
    <Row role="checkbox" label={props.label} selected={props.value} disabled={props.disabled} onPress={() => props.onValueChange(!props.value)}
      control={<View style={{ width: s(20), height: s(20), borderRadius: s(6), borderWidth: 1.5, borderColor: props.value ? colors.accent : colors.textSecondary, backgroundColor: props.value ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>{props.value ? <Icon name="checkmark" size={sc(14)} color="onAccent" /> : null}</View>} />
  );
}

export function Radio(props: { label: string; selected: boolean; onPress: () => void; disabled?: boolean | undefined }) {
  const { colors, s } = useTheme();
  return (
    <Row role="radio" label={props.label} selected={props.selected} disabled={props.disabled} onPress={props.onPress}
      control={<View style={{ width: s(20), height: s(20), borderRadius: s(10), borderWidth: 1, borderColor: props.selected ? colors.accent : colors.textSecondary, alignItems: "center", justifyContent: "center" }}>{props.selected ? <View style={{ width: s(10), height: s(10), borderRadius: s(5), backgroundColor: colors.accent }} /> : null}</View>} />
  );
}

/** Switch with a thumb that slides along the inline axis (mirrors in RTL). Name kept for existing screens. */
export function SwitchRow(props: { label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean | undefined }) {
  const { colors, reduceMotion, isRTL, s } = useTheme();
  const t = useSharedValue(props.value ? 1 : 0);
  const slide = s(20);
  useEffect(() => { t.value = withTiming(props.value ? 1 : 0, { duration: reduceMotion ? 0 : motion.fast, easing: Easing.out(Easing.cubic) }); }, [props.value, t, reduceMotion]);
  const sign = inlineSign(isRTL);
  // Thumb rests at `start: 2` and slides 20pt along the inline axis with a transform (no layout work per frame).
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(t.value, [0, 1], [0, slide]) * sign }] }));
  return (
    <Row role="switch" label={props.label} selected={props.value} disabled={props.disabled} onPress={() => props.onValueChange(!props.value)}
      control={
        <View style={{ width: s(46), height: s(26), borderRadius: s(13), borderWidth: 1, borderColor: props.value ? colors.accent : colors.textSecondary, backgroundColor: props.value ? colors.accent : "transparent" }}>
          <Animated.View style={[{ position: "absolute", top: s(2), start: s(2), width: s(20), height: s(20), borderRadius: s(10), backgroundColor: props.value ? colors.onAccent : colors.textSecondary }, thumb]} />
        </View>
      } />
  );
}

/**
 * Fully round chip: quiet fill, selected = deep ink fill. Density v2: visual height 34pt (compact 30, large 40) and
 * `hitSlop` from `slopFor` lifts every touch target to >= 44pt. Grows with Dynamic Type (minHeight, no fixed height). `role` and `accessibilityLabel` cover the
 * radio/checkbox use in search, PDP, wishlists and size profile, so feature code needs no private chip.
 */
export function Chip(props: { density?: Density | undefined; large?: boolean | undefined; label: string; selected?: boolean | undefined; onPress?: (() => void) | undefined; icon?: IconName | undefined; disabled?: boolean | undefined; testID?: string | undefined; role?: "button" | "radio" | "checkbox" | undefined; accessibilityLabel?: string | undefined; /** Overrides the announced selected state (a "Remove X" chip looks selected but must not read "selected"). */ accessibilitySelected?: boolean | undefined }) {
  const { colors, s, sc, controls } = useTheme();
  const sel = props.selected === true;
  const role = props.role ?? "button";
  const dense = props.density === "compact";
  const visual = dense ? controls.chipCompact : props.large === true ? controls.chipLarge : controls.chip;
  const body = (
    <View style={{ minHeight: visual, minWidth: minTouchTarget, justifyContent: "center", paddingHorizontal: dense ? s(10) : s(14), flexDirection: "row", alignItems: "center", gap: s(6), borderWidth: 1, borderColor: sel ? colors.accent : colors.fieldBorder, backgroundColor: sel ? colors.accent : "transparent", borderRadius: radius.pill, opacity: props.disabled === true ? 0.5 : 1 }}>
      {props.icon !== undefined ? <Icon name={props.icon} size={sc(14)} color={sel ? "onAccent" : "textPrimary"} /> : null}
      <Text variant={props.large === true ? "callout" : "caption"} weight="500" color={sel ? "onAccent" : "textPrimary"} accessibilityRole="none">{props.label}</Text>
    </View>
  );
  if (props.onPress === undefined) return body;
  const state = role === "checkbox" ? { checked: sel, disabled: props.disabled === true } : { selected: props.accessibilitySelected ?? sel, disabled: props.disabled === true };
  return (
    <PressScale testID={props.testID} onPress={props.onPress} disabled={props.disabled} accessibilityRole={role} accessibilityLabel={props.accessibilityLabel ?? props.label} accessibilityState={state} hitSlop={slopFor(visual)}>
      {body}
    </PressScale>
  );
}

/** Tabs with a sliding underline indicator (sentence case, Inter 500). */
export function SegmentedControl(props: { options: readonly string[]; index: number; onChange: (i: number) => void; testID?: string | undefined }) {
  const { colors, isRTL, reduceMotion, sc } = useTheme();
  const [w, setW] = useState(0);
  const n = Math.max(1, props.options.length);
  const segW = w / n;
  const x = useSharedValue(0);
  useEffect(() => { x.value = withTiming(props.index * segW * inlineSign(isRTL), { duration: reduceMotion ? 0 : motion.base, easing: Easing.out(Easing.cubic) }); }, [props.index, segW, isRTL, x, reduceMotion]);
  const ind = useAnimatedStyle(() => ({ width: segW, transform: [{ translateX: x.value }] }));
  return (
    <View testID={props.testID} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
      {props.options.map((o, i) => (
        <Pressable key={o} accessibilityRole="tab" accessibilityLabel={o} accessibilityState={{ selected: i === props.index }} onPress={() => { if (i !== props.index) { selectionTick(); props.onChange(i); } }} style={{ flex: 1, minHeight: sc(minTouchTarget), alignItems: "center", justifyContent: "center" }}>
          <Text variant="callout" weight="500" color={i === props.index ? "textPrimary" : "textSecondary"} accessibilityRole="none">{o}</Text>
        </Pressable>
      ))}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", bottom: -1, start: 0, height: 2, backgroundColor: colors.brand }, ind]} />
    </View>
  );
}

export function QuantityStepper(props: { value: number; onChange: (v: number) => void; min?: number | undefined; max?: number | undefined; valueLabel?: string | undefined; decrementLabel: string; incrementLabel: string }) {
  const { colors, s } = useTheme();
  const min = props.min ?? 1;
  const max = props.max ?? 10;
  const dec = stepQuantity(props.value, -1, min, max);
  const inc = stepQuantity(props.value, 1, min, max);
  return (
    <View accessibilityRole="adjustable" accessibilityValue={{ min, max, now: props.value }} style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill }}>
      <IconButton icon="remove" label={props.decrementLabel} disabled={dec === null} onPress={() => { if (dec !== null) props.onChange(dec); }} size={18} />
      <View style={{ minWidth: s(28), alignItems: "center" }}><Text variant="callout" numeric accessibilityRole="none">{props.valueLabel ?? String(props.value)}</Text></View>
      <IconButton icon="add" label={props.incrementLabel} disabled={inc === null} onPress={() => { if (inc !== null) props.onChange(inc); }} size={18} />
    </View>
  );
}

export interface SizeOption { readonly id: string; readonly label: string; readonly available: boolean; readonly yours?: boolean | undefined }
/** Rounded squares (40pt visual, hitSlop to 44): available, unavailable (struck, dimmed), selected (deep ink fill), your-size (ring). */
export function SizeSelector(props: { options: readonly SizeOption[]; selectedId: string | null; onSelect: (id: string) => void; yourSizeLabel?: string | undefined; unavailableLabel?: string | undefined }) {
  const { colors, s, controls, radii } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: s(8) }}>
      {props.options.map((o) => {
        const v = sizeCellView({ available: o.available, selected: o.id === props.selectedId, yours: o.yours === true });
        return (
          <Pressable key={o.id} disabled={!v.interactive} onPress={() => { selectionTick(); props.onSelect(o.id); }}
            hitSlop={slopFor(controls.sizeCell)}
            accessibilityRole="button"
            accessibilityLabel={joinLabel(o.label, !o.available ? props.unavailableLabel : undefined, o.yours === true ? props.yourSizeLabel : undefined)}
            accessibilityState={{ selected: o.id === props.selectedId, disabled: !v.interactive }}
            style={{ minWidth: controls.sizeCell, minHeight: controls.sizeCell, paddingHorizontal: s(10), borderRadius: radii.md, alignItems: "center", justifyContent: "center", borderWidth: v.ring ? 1.5 : 1, borderColor: v.filled ? colors.accent : v.ring ? colors.textPrimary : colors.border, backgroundColor: v.filled ? colors.accent : "transparent", opacity: v.opacity }}>
            <Text variant="callout" weight="500" color={v.filled ? "onAccent" : "textPrimary"} accessibilityRole="none" style={v.strike ? { textDecorationLine: "line-through" } : undefined}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Thin progress line (free-delivery). Fills along the inline axis; turns emerald when complete. */
export function ProgressBar(props: { current: number; target: number; label?: string | undefined }) {
  const { colors, reduceMotion, isRTL, s } = useTheme();
  const r = progressRatio(props.current, props.target);
  const p = useSharedValue(r);
  useEffect(() => { p.value = withTiming(r, { duration: reduceMotion ? 0 : motion.slow, easing: Easing.out(Easing.cubic) }); }, [r, p, reduceMotion]);
  // Full-width fill scaled from the inline-start edge (transform, not width).
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: p.value }] }));
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} accessibilityValue={{ min: 0, max: 100, now: Math.round(r * 100) }} style={{ height: s(4), borderRadius: s(2), backgroundColor: colors.fill, overflow: "hidden" }}>
      <Animated.View style={[{ height: s(4), width: "100%", borderRadius: s(2), transformOrigin: isRTL ? "right" : "left", backgroundColor: r >= 1 ? colors.savings : colors.accent }, fill]} />
    </View>
  );
}

/** Pill search field with a leading search icon (the reference's search bar). Optional trailing node (e.g. a filter button). */
export function SearchField(props: { value: string; onChangeText: (v: string) => void; placeholder: string; label?: string | undefined; onSubmit?: (() => void) | undefined; trailing?: ReactNode; autoFocus?: boolean | undefined; testID?: string | undefined; clearLabel?: string | undefined }) {
  const { colors, type, s, sc, controls, radii } = useTheme();
  return (
    <View style={{ minHeight: controls.search, flexDirection: "row", alignItems: "center", gap: s(8), paddingHorizontal: s(14), borderRadius: radii.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      <Icon name="search" size={sc(17)} color="textSecondary" />
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        onSubmitEditing={props.onSubmit}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textSecondary}
        returnKeyType="search"
        autoFocus={props.autoFocus}
        allowFontScaling
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={props.label ?? props.placeholder}
        selectionColor={colors.textPrimary}
        style={[type("callout"), { flex: 1, color: colors.textPrimary, paddingVertical: s(10), textAlign: "auto" }]}
      />
      {props.value.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={props.clearLabel ?? "Clear"} hitSlop={s(13)} onPress={() => props.onChangeText("")}>
          <Icon name="close-circle" size={sc(18)} color="textSecondary" />
        </Pressable>
      ) : null}
      {props.trailing}
    </View>
  );
}

/** One-line segmented choice: equal widths, no wrapping, selected = dark fill. 32pt visual, 44pt hit area. */
export function SegmentedChoice(props: { label?: string | undefined; options: readonly { readonly id: string; readonly label: string; readonly testID?: string | undefined }[]; value: string | null; onChange: (id: string) => void; onLayout?: ((e: LayoutChangeEvent) => void) | undefined }) {
  const { colors, s, sized, radii } = useTheme();
  return (
    <View onLayout={props.onLayout} style={{ gap: s(6) }}>
      {props.label !== undefined ? <Text variant="callout" weight="500" style={sized(13, 18)} accessibilityRole="none">{props.label}</Text> : null}
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: s(6) }}>
        {props.options.map((o) => {
          const sel = props.value === o.id;
          return (
            <PressScale key={o.id} testID={o.testID} onPress={() => { selectionTick(); props.onChange(o.id); }} accessibilityRole="radio" accessibilityLabel={o.label} accessibilityState={{ selected: sel }} hitSlop={s(6)} style={{ flex: 1 }}>
              <View style={{ minHeight: s(32), alignItems: "center", justifyContent: "center", paddingHorizontal: s(4), borderRadius: radii.pill, borderWidth: 1, borderColor: sel ? colors.accent : colors.fieldBorder, backgroundColor: sel ? colors.accent : "transparent" }}>
                <Text variant="caption" weight="500" color={sel ? "onAccent" : "textPrimary"} numberOfLines={1} accessibilityRole="none">{o.label}</Text>
              </View>
            </PressScale>
          );
        })}
      </View>
    </View>
  );
}

/** Select row: label above, one 44pt control showing the current value (or placeholder) and a chevron. Opens a picker (caller's sheet). */
export function SelectRow(props: { label: string; value?: string | undefined; placeholder: string; onPress: () => void; required?: boolean | undefined; error?: string | undefined; helper?: string | undefined; testID?: string | undefined; onLayout?: ((e: LayoutChangeEvent) => void) | undefined }) {
  const { colors, s, sc, sized, radii } = useTheme();
  const has = props.value !== undefined && props.value !== "";
  return (
    <View onLayout={props.onLayout} style={{ gap: s(6) }}>
      <View style={{ flexDirection: "row", gap: s(6) }}>
        <Text variant="callout" weight="500" style={sized(13, 18)} accessibilityRole="none">{props.label}</Text>
        {props.required === true ? <Text variant="callout" weight="600" color="danger" style={sized(13, 18)} accessibilityRole="none">*</Text> : null}
      </View>
      <PressScale testID={props.testID} onPress={props.onPress} accessibilityRole="button" accessibilityLabel={`${props.label}, ${has ? props.value : props.placeholder}`}>
        <View style={{ minHeight: sc(44), flexDirection: "row", alignItems: "center", gap: s(8), paddingHorizontal: s(12), borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: props.error !== undefined ? colors.danger : colors.fieldBorder }}>
          <Text variant="callout" secondary={!has} numberOfLines={1} style={{ flex: 1 }} accessibilityRole="none">{has ? props.value : props.placeholder}</Text>
          <Icon name="chevron-down" size={sc(16)} color="textSecondary" />
        </View>
      </PressScale>
      {props.error !== undefined ? <Text variant="caption" color="danger">{props.error}</Text> : props.helper !== undefined ? <Text variant="caption" secondary>{props.helper}</Text> : null}
    </View>
  );
}
