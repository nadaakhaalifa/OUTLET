import { useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { shadows } from "@outlet/ui-tokens";
import { useLayout, useTheme } from "../theme";
import { chevronName } from "../logic/rtl";
import { joinLabel } from "../logic/a11y";
import { toneColors, type Tone } from "../logic/palette";
import { Button } from "./controls";
import { AppBar, ColumnContext, GutterContext, TabBarInsetContext } from "./glass";
import { layoutMetrics } from "@outlet/ui-tokens";
import { columnMaxWidth, columnsFor, contentColumnWidth, tabBarZoomExtra, type ContentWidthKind, type GridPreference } from "../logic/size-class";
import { ScrollYContext } from "./motion";
import { LinearGradient } from "expo-linear-gradient";
import { motion } from "@outlet/ui-tokens";
import { Divider, Icon, PressScale, Text, type IconName } from "./primitives";

/** Set by the tab layout so Screen pads its bottom edge past the floating tab bar. */
export { TabBarInsetContext };

export interface ScreenProps {
  children: ReactNode;
  /** Legacy: false renders a non-scrolling column. */
  scroll?: boolean | undefined;
  /** Large light display title that collapses into a glass app bar on scroll. */
  title?: string | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  trailing?: ReactNode;
  refreshing?: boolean | undefined;
  onRefresh?: (() => void) | undefined;
  /** Sticky footer (use StickyBar). Sits below the scroll content. */
  footer?: ReactNode;
  /** Horizontal gutter + vertical gap. Default true. Pass false for full-bleed layouts (use GutterContext-aware FullBleedHero). */
  padded?: boolean | undefined;
  /** Horizontal gutter override (nominal pt, zoomed by the kit). Default is the token gutter (16 compact, zoomed on iPad). */
  gutter?: number | undefined;
  /**
   * Max width of the centred content column on regular and expanded windows: form 560, reading 720 (default), grid 1280, full
   * (no cap). Compact (iPhone) is never capped. `padded={false}` screens are full-bleed and never capped.
   */
  width?: "reading" | "form" | "grid" | "full" | undefined;
  contentStyle?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
  /** Default true. Set false on screens whose content is a full-bleed image under the status bar (Home hero). */
  statusScrim?: boolean | undefined;
}

/**
 * Safe-area aware page. Top inset clears the Dynamic Island; bottom clears the tab bar (via TabBarInsetContext)
 * or the home indicator. Content scrolls under the glass tab bar rather than being clipped by it.
 */
export function Screen(props: ScreenProps) {
  const { colors, spacing, reduceMotion, s, controls, layout, gutter } = useTheme();
  const insets = useSafeAreaInsets();
  const tabInset = useContext(TabBarInsetContext);
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { y.value = e.contentOffset.y; });
  const hasBar = props.title !== undefined || props.onBack !== undefined;
  const titleOp = useAnimatedStyle(() => {
    // Inline math: worklets cannot call plain JS helpers (see logic/motion.ts collapseProgress for the tested twin).
    const p = Math.min(1, Math.max(0, y.value / 72));
    return { opacity: 1 - p, transform: [{ translateY: -p * 14 }, { scale: 1 - p * 0.06 }] };
  });
  const top = hasBar ? insets.top + controls.appBar : insets.top + spacing.md;
  // The zoomed tab bar is taller than the compact inset the tab layout passes in; add the difference.
  const tabClear = tabInset > 0 ? tabInset + tabBarZoomExtra(layout.z) : insets.bottom;
  const bottom = props.footer !== undefined ? spacing.xl : tabClear + spacing.xl;
  const padH = props.padded === false ? 0 : props.gutter !== undefined ? s(props.gutter) : gutter;
  const colMax = props.padded === false ? null : columnMaxWidth(props.width ?? "reading", layout.sizeClass, padH, layout.z);
  const body = (
    <GutterContext.Provider value={padH}>
      <ScrollYContext.Provider value={y}>
      <View style={[{ paddingTop: top, paddingBottom: bottom, paddingHorizontal: padH, gap: props.padded === false ? 0 : layout.sectionGap }, colMax !== null ? { width: "100%", maxWidth: colMax, alignSelf: "center" } : null, props.contentStyle]}>
        {props.title !== undefined ? <Animated.View style={reduceMotion ? undefined : titleOp}><Text variant="display" accessibilityRole="header" style={{ marginBottom: spacing.sm }}>{props.title}</Text></Animated.View> : null}
        {props.children}
      </View>
      </ScrollYContext.Provider>
    </GutterContext.Provider>
  );
  return (
    <ColumnContext.Provider value={colMax}>
    <View testID={props.testID} style={{ flex: 1, backgroundColor: colors.background }}>
      {props.scroll === false ? <View style={{ flex: 1 }}>{body}</View> : (
        <Animated.ScrollView
          style={{ flex: 1 }}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="never"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={props.onRefresh ? <RefreshControl refreshing={props.refreshing === true} onRefresh={props.onRefresh} tintColor={colors.textSecondary} progressViewOffset={top} /> : undefined}
        >
          {body}
        </Animated.ScrollView>
      )}
      {!hasBar && props.statusScrim !== false && insets.top > 0 ? <StatusScrim height={insets.top + 10} color={colors.background} /> : null}
      {hasBar ? <AppBar floating glass title={props.title} onBack={props.onBack} backLabel={props.backLabel} trailing={props.trailing} scrollY={y} /> : null}
      {props.footer}
    </View>
    </ColumnContext.Provider>
  );
}

/** Top safe-area scrim so scrolled content never collides with the clock: opaque-ish ivory fading out. */
function StatusScrim(props: { height: number; color: string }) {
  const c = props.color;
  const solid = /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
  if (solid === null) return null;
  return (
    <LinearGradient
      pointerEvents="none"
      testID="status-scrim"
      colors={[`${solid}F2`, `${solid}CC`, `${solid}00`]}
      locations={[0, 0.7, 1]}
      style={{ position: "absolute", top: 0, start: 0, end: 0, height: props.height }}
    />
  );
}

/**
 * Unboxed group by default (no boxes within boxes). `elevated` = surface, radius 18, soft shadow (the one raised card per
 * section); `outlined` = hairline box radius 18; `filled` = quiet fill radius 18.
 */
export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle>; variant?: "plain" | "outlined" | "filled" | "elevated" | undefined }) {
  const { colors, s, radii } = useTheme();
  const v = props.variant ?? "plain";
  const boxed = v !== "plain";
  return <View style={[{ gap: s(8), paddingVertical: boxed ? s(14) : s(4), paddingHorizontal: boxed ? s(14) : 0, borderRadius: boxed ? radii.lg : 0 }, v === "outlined" ? { borderWidth: 1, borderColor: colors.border } : v === "filled" ? { backgroundColor: colors.fill } : v === "elevated" ? { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline, ...shadows.card } : null, props.style]}>{props.children}</View>;
}

export function SectionHeader(props: { title: string; actionLabel?: string | undefined; onAction?: (() => void) | undefined }) {
  const { s, sc } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: s(32) }}>
      <Text variant="title2" weight="500" color="textPrimary" accessibilityRole="header">{props.title}</Text>
      {props.actionLabel && props.onAction ? (
        <PressScale onPress={props.onAction} accessibilityRole="button" accessibilityLabel={props.actionLabel} hitSlop={s(8)} innerStyle={{ minHeight: sc(44), justifyContent: "center" }}>
          <Text variant="caption" weight="500" secondary accessibilityRole="none">{props.actionLabel}</Text>
        </PressScale>
      ) : null}
    </View>
  );
}

/** Row with optional leading icon, title/subtitle, trailing value and a chevron that mirrors in RTL. */
export function ListRow(props: { title: string; subtitle?: string | undefined; trailing?: ReactNode; value?: string | undefined; leadingIcon?: IconName | undefined; onPress?: (() => void) | undefined; accessibilityHint?: string | undefined; chevron?: boolean | undefined; divider?: boolean | undefined; testID?: string | undefined }) {
  const { isRTL, s, sc, controls } = useTheme();
  const showChevron = props.chevron ?? props.onPress !== undefined;
  const body = (
    <View style={{ minHeight: controls.listRow, paddingVertical: s(10), flexDirection: "row", alignItems: "center", gap: s(12) }}>
      {props.leadingIcon ? <Icon name={props.leadingIcon} size={sc(20)} /> : null}
      <View style={{ flex: 1, gap: s(2) }}>
        <Text variant="body" accessibilityRole="none">{props.title}</Text>
        {props.subtitle ? <Text variant="caption" secondary accessibilityRole="none">{props.subtitle}</Text> : null}
      </View>
      {props.value ? <Text variant="callout" secondary accessibilityRole="none">{props.value}</Text> : null}
      {props.trailing}
      {showChevron ? <Icon name={chevronName(isRTL)} size={sc(15)} color="textSecondary" /> : null}
    </View>
  );
  const wrapped = props.onPress ? (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={joinLabel(props.title, props.subtitle, props.value)} accessibilityHint={props.accessibilityHint} testID={props.testID} scale={0.995}>{body}</PressScale>
  ) : body;
  return props.divider === true ? <View>{wrapped}<Divider /></View> : wrapped;
}

const TONE_ICON: Record<Tone, IconName> = { info: "information-circle-outline", warning: "warning-outline", error: "alert-circle-outline", success: "checkmark-circle-outline" };

/** Icon + message strip. Tone is carried by icon, edge rule and (optional) accessible prefix: never a text prefix. */
export function Banner(props: { tone: Tone; message: string; prefix?: string | undefined; testID?: string | undefined }) {
  const { scheme, s, sc, radii } = useTheme();
  const t = toneColors(props.tone, scheme);
  return (
    <View testID={props.testID} accessibilityRole="alert" accessibilityLabel={joinLabel(props.prefix, props.message)} style={{ flexDirection: "row", alignItems: "flex-start", gap: s(10), paddingVertical: s(10), paddingHorizontal: s(12), backgroundColor: t.background, borderRadius: radii.md, borderWidth: 1, borderColor: t.border }}>
      <View style={{ paddingTop: s(2) }}><Icon name={TONE_ICON[props.tone]} size={sc(17)} color={props.tone === "error" ? "danger" : props.tone === "success" ? "savings" : "textPrimary"} /></View>
      <Text variant="callout" style={{ color: t.foreground, flex: 1 }} accessibilityRole="none">{props.message}</Text>
    </View>
  );
}

export function EmptyState(props: { title: string; description?: string | undefined; actionTitle?: string | undefined; onAction?: (() => void) | undefined; illustration?: ReactNode }) {
  const { s } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: s(40), paddingHorizontal: s(12), gap: s(12) }}>
      {props.illustration}
      <Text variant="title2" align="center">{props.title}</Text>
      {props.description ? <Text variant="callout" secondary align="center">{props.description}</Text> : null}
      {props.actionTitle && props.onAction ? <View style={{ alignSelf: "stretch", marginTop: s(8) }}><Button title={props.actionTitle} onPress={props.onAction} variant="secondary" /></View> : null}
    </View>
  );
}

/** Copy is supplied by the caller (i18n). Offline shares the layout with a distinct title. */
export function ErrorState(props: { title: string; description?: string | undefined; retryTitle: string; onRetry: () => void; offline?: boolean | undefined }) {
  const { s, sc } = useTheme();
  return (
    <View accessibilityRole={props.offline === true ? "summary" : "alert"} style={{ alignItems: "center", paddingVertical: s(40), paddingHorizontal: s(12), gap: s(12) }}>
      <Icon name={props.offline === true ? "cloud-offline-outline" : "alert-circle-outline"} size={sc(26)} color="textSecondary" />
      <Text variant="title2" align="center">{props.title}</Text>
      {props.description ? <Text variant="callout" secondary align="center">{props.description}</Text> : null}
      <View style={{ alignSelf: "stretch", marginTop: s(8) }}><Button title={props.retryTitle} onPress={props.onRetry} /></View>
    </View>
  );
}

export function LoadingState(props: { label: string }) {
  const { colors, s } = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} accessibilityState={{ busy: true }} style={{ alignItems: "center", paddingVertical: s(40), gap: s(10) }}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text variant="caption" secondary>{props.label}</Text>
    </View>
  );
}

/** Skeleton with a slow diagonal shimmer sweep (transform only). Static when Reduce Motion is on. Hidden from screen readers. */
export function Skeleton(props: { width?: number | `${number}%` | undefined; height?: number | undefined; radius?: number | undefined; style?: StyleProp<ViewStyle> | undefined }) {
  const { colors, reduceMotion, s, radii } = useTheme();
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) { x.value = 0; return; }
    x.value = withRepeat(withTiming(1, { duration: motion.hero * 2, easing: Easing.bezier(0.65, 0, 0.35, 1) }), -1, false);
  }, [x, reduceMotion]);
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(x.value, [0, 1], [-w, w]) }] }));
  const sheen = colors.glassSheen;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      style={[{ width: typeof props.width === "number" ? s(props.width) : props.width ?? "100%", height: s(props.height ?? 16), borderRadius: props.radius !== undefined ? s(props.radius) : radii.sm, backgroundColor: colors.fill, overflow: "hidden" }, props.style]}
    >
      {reduceMotion || w === 0 ? null : (
        <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, width: w * 0.6 }, band]}>
          <LinearGradient colors={[colors.glassSheenFade, sheen, colors.glassSheenFade]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
        </Animated.View>
      )}
    </View>
  );
}

/** Centred block capped to a content width on regular and expanded windows (never on compact). Use inside a Screen for text columns. */
export function ContentColumn(props: { width?: Exclude<ContentWidthKind, "full"> | undefined; children: ReactNode; style?: StyleProp<ViewStyle> | undefined; testID?: string | undefined }) {
  const layout = useLayout();
  const max = layout.sizeClass === "compact" ? null : contentColumnWidth(props.width ?? "reading", layout.windowWidth);
  return <View testID={props.testID} style={[max !== null ? { width: "100%", maxWidth: max, alignSelf: "center" } : null, props.style]}>{props.children}</View>;
}

/**
 * Two panes side by side from effective content width >= 760 (13-inch portrait and every landscape iPad), otherwise `single`
 * (or the two panes stacked). Panes sit in a row, so the logical start pane is on the right in Arabic. `fixedWidth` is in
 * EFFECTIVE points (zoomed by the kit); the other pane takes the rest.
 */
export function TwoPane(props: { start: ReactNode; end: ReactNode; fixed?: "start" | "end" | undefined; fixedWidth: number; gap?: number | undefined; single?: ReactNode; testID?: string | undefined }) {
  const { s } = useTheme();
  const layout = useLayout();
  if (layout.paneLayout !== "two") return <View testID={props.testID} style={{ gap: layout.sectionGap }}>{props.single ?? <>{props.start}{props.end}</>}</View>;
  const fixedStart = (props.fixed ?? "start") === "start";
  const fixedStyle: ViewStyle = { width: s(props.fixedWidth) };
  return (
    <View testID={props.testID} style={{ flexDirection: "row", alignItems: "flex-start", gap: s(props.gap ?? 20) }}>
      <View style={fixedStart ? fixedStyle : { flex: 1 }}>{props.start}</View>
      <View style={fixedStart ? { flex: 1 } : fixedStyle}>{props.end}</View>
    </View>
  );
}

/**
 * Responsive card grid. Compact (iPhone): `preference` is the fixed number of columns, as before. Regular and expanded:
 * columns = columnsFor(effective grid width, preference, font scale). Cards are `cardWidth` wide, start-aligned, wrapped.
 */
export function AdaptiveGrid<T>(props: { data: readonly T[]; keyExtractor: (item: T) => string; renderItem: (item: T, index: number, cardWidth: number) => ReactNode; preference?: GridPreference | undefined; testID?: string | undefined }) {
  const { s } = useTheme();
  const layout = useLayout();
  const [measured, setMeasured] = useState(0);
  const width = measured > 0 ? measured : Math.max(0, layout.windowWidth - 2 * layout.gutter);
  const pref = props.preference ?? 2;
  const gapEff = layoutMetrics[layout.sizeClass].gridGap;
  const cols = layout.sizeClass === "compact" ? pref : columnsFor(width / layout.z, pref, layout.fontScale, gapEff);
  const gap = s(gapEff);
  const card = Math.max(0, Math.floor((width - gap * (cols - 1)) / cols));
  return (
    <View testID={props.testID} onLayout={(e: LayoutChangeEvent) => setMeasured(e.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
      {props.data.map((item, i) => <View key={props.keyExtractor(item)} style={{ width: card }}>{props.renderItem(item, i, card)}</View>)}
    </View>
  );
}
