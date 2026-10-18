import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
// `runOnJS` is the Reanimated 4 compatibility name (deprecated in react-native-worklets 0.10 in favour of
// `scheduleOnRN`). It is a thin wrapper over scheduleOnRN and works in Expo Go. Migrate by adding
// `react-native-worklets` as a ui-native peer dependency and swapping the three call sites.
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { Image, type ImageSource } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { glass, minTouchTarget, motion, radius as radii, shadows } from "@outlet/ui-tokens";
import { SchemeScope, useLayout, useTheme } from "../theme";
import { glassMode, glassStyle, scrimStops } from "../logic/glass";
import { tabBarInset, tabBarBottomPad, tabBadgeText, TAB_BAR_CONTENT_HEIGHT } from "../logic/misc";
import { formSheetMaxHeight, formSheetWidth, tabBarWidthCap, tabBarZoomExtra, toastWidthCap } from "../logic/size-class";
import { useScrollY } from "./motion";
import { Eyebrow, Icon, PressScale, Text, selectionTick, type IconName } from "./primitives";

const BLUR_SUPPORTED = Platform.OS === "ios";

/**
 * Frosted glass. BlurView + translucent tint + 1px hairline + inner top highlight + soft shadow.
 * Falls back to a solid surface when Reduce Transparency is on or blur is unsupported.
 */
export function GlassSurface(props: {
  children?: ReactNode;
  intensity?: number | undefined;
  radius?: number | undefined;
  elevated?: boolean | undefined;
  /** Hide the border on the given sides (full-width bars draw only the inner edge). */
  edges?: "all" | "top" | "bottom" | "none" | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  innerStyle?: StyleProp<ViewStyle> | undefined;
  /** Extra fill drawn over the blur (innerStyle backgrounds sit under it). Use a dark tint for glass chips over imagery. */
  tint?: string | undefined;
  testID?: string | undefined;
}) {
  const { colors, isDark, reduceTransparency } = useTheme();
  const mode = glassMode({ reduceTransparency, blurSupported: BLUR_SUPPORTED });
  const g = glassStyle(mode, isDark, colors, props.intensity ?? glass.intensity.bar);
  const r = props.radius ?? 0;
  const edges = props.edges ?? "all";
  const border: ViewStyle = edges === "all" ? { borderWidth: StyleSheet.hairlineWidth, borderColor: g.borderColor }
    : edges === "top" ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: g.borderColor }
    : edges === "bottom" ? { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: g.borderColor } : {};
  return (
    <View testID={props.testID} style={[props.elevated === true ? shadows.floating : null, props.style]}>
      <View style={[{ borderRadius: r, overflow: "hidden" }, border, props.innerStyle]}>
        {mode === "blur" ? <BlurView intensity={g.blurIntensity} tint={g.blurTint} style={StyleSheet.absoluteFill} /> : null}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: g.backgroundColor }]} />
        {props.tint !== undefined ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: props.tint }]} /> : null}
        {/* Depth: diagonal sheen from the lit corner, soft inner shadow on the lower edge, 1px top highlight. */}
        <LinearGradient pointerEvents="none" colors={[g.sheen, g.sheenFade]} start={{ x: 0, y: 0 }} end={{ x: 0.85, y: 1 }} style={StyleSheet.absoluteFill} />
        <LinearGradient pointerEvents="none" colors={[g.shadeFade, g.shade]} locations={[0.55, 1]} style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={{ position: "absolute", top: 0, start: r > 0 ? r * 0.6 : 0, end: r > 0 ? r * 0.6 : 0, height: 1, backgroundColor: g.highlight }} />
        {props.children}
      </View>
    </View>
  );
}

/** Gradient scrim that keeps white text AA over any photo. */
export function Scrim(props: { position?: "bottom" | "top" | "both" | undefined; style?: StyleProp<ViewStyle> | undefined }) {
  const s = scrimStops(props.position ?? "bottom");
  return <LinearGradient pointerEvents="none" colors={s.colors as [string, string, ...string[]]} locations={s.locations as [number, number, ...number[]]} style={[StyleSheet.absoluteFill, props.style]} />;
}

export const GutterContext = createContext<number>(0);
/** Max physical width of the centred content column (content + gutters), set by Screen. Null = no cap. AppBar and StickyBar align to it. */
export const ColumnContext = createContext<number | null>(null);
/** Set by the tab layout so Screen and StickyBar clear the floating tab bar. Lives here so glass and layout share it without a cycle. */
export const TabBarInsetContext = createContext<number>(0);

/** Edge-to-edge hero. `image` is a source, or pass `imageNode` (art kit placeholder). Text sits on a scrim in onImage colour. */
export function FullBleedHero(props: {
  image?: ImageSource | undefined;
  imageNode?: ReactNode;
  blurhash?: string | undefined;
  height?: number | undefined;
  aspectRatio?: number | undefined;
  eyebrow?: string | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  action?: ReactNode;
  scrim?: "bottom" | "top" | "both" | undefined;
  onPress?: (() => void) | undefined;
  accessibilityLabel?: string | undefined;
  /** Cancel the surrounding screen gutter so the hero touches both edges. Default true. */
  bleed?: boolean | undefined;
  /** Corner radius for an inset (non-bleed) hero banner, e.g. radius.lg + 2. Default 0. */
  cornerRadius?: number | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  children?: ReactNode;
}) {
  const { colors, spacing, reduceMotion, s } = useTheme();
  const gutterPad = useContext(GutterContext);
  const scrollY = useScrollY();
  const m = props.bleed === false ? 0 : -gutterPad;
  const sizing: ViewStyle = props.height !== undefined ? { height: props.height } : { aspectRatio: props.aspectRatio ?? 4 / 5 };
  const h = props.height ?? 480;
  // Entrance: the image settles from a slight zoom. Scroll: parallax drift, and pull-down zoom to fill.
  const settle = useSharedValue(reduceMotion ? 1 : motion.heroScaleFrom);
  useEffect(() => {
    if (!reduceMotion) settle.value = withTiming(1, { duration: motion.hero, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [reduceMotion, settle]);
  const imageAnim = useAnimatedStyle(() => {
    // Inline math (worklets cannot call plain JS helpers); logic/motion.ts heroParallax is the tested twin.
    const sy = scrollY !== null && !reduceMotion ? scrollY.value : 0;
    const ty = sy < 0 ? sy / 2 : sy * 0.4;
    const sc = sy < 0 ? 1 + Math.min(-sy, h) / h : 1;
    return { transform: [{ translateY: ty }, { scale: settle.value * sc }] };
  });
  const body = (
    <View style={[{ marginHorizontal: m, backgroundColor: colors.fill, overflow: "hidden", justifyContent: "flex-end", borderRadius: props.cornerRadius ?? 0 }, sizing, props.style]}>
      <Animated.View style={[StyleSheet.absoluteFill, imageAnim]}>
        {props.imageNode !== undefined ? <View style={StyleSheet.absoluteFill}>{props.imageNode}</View>
          : props.image !== undefined ? <Image source={props.image} placeholder={props.blurhash !== undefined ? { blurhash: props.blurhash } : null} contentFit="cover" transition={360} style={StyleSheet.absoluteFill} accessible={false} /> : null}
      </Animated.View>
      <Scrim position={props.scrim ?? "bottom"} />
      <View style={{ paddingHorizontal: gutterPad > 0 ? gutterPad : spacing.lg + s(4), paddingBottom: spacing.xl, paddingTop: spacing.lg + s(4), gap: spacing.sm }}>
        {props.eyebrow !== undefined ? (
          <View style={{ gap: spacing.sm }}>
            <View style={{ width: s(28), height: 1, backgroundColor: colors.sand }} />
            <Eyebrow color="onImage">{props.eyebrow}</Eyebrow>
          </View>
        ) : null}
        {props.title !== undefined ? <Text variant="display" color="onImage">{props.title}</Text> : null}
        {props.subtitle !== undefined ? <Text variant="callout" color="onImage">{props.subtitle}</Text> : null}
        {props.action}
        {props.children}
      </View>
    </View>
  );
  return props.onPress !== undefined ? <Pressable accessibilityRole="button" accessibilityLabel={props.accessibilityLabel ?? props.title} onPress={props.onPress}>{body}</Pressable> : body;
}

/**
 * Round icon button. `glass` floats over imagery; `solid` is an ivory disc for photos (back, heart);
 * `sand` is the circular category shortcut (sand disc, ink glyph, optional `caption` under it). Always >= 44pt.
 */
export function IconButton(props: { icon: IconName; label: string; onPress: () => void; variant?: "plain" | "glass" | "solid" | "sand" | undefined; caption?: string | undefined; size?: number | undefined; disabled?: boolean | undefined; directional?: boolean | undefined; color?: "textPrimary" | "onImage" | "textSecondary" | undefined; testID?: string | undefined }) {
  const { colors, s, sc, controls } = useTheme();
  // `size` is the nominal (compact) glyph size; the kit zooms it. The tap box is the 44pt minimum, zoomed.
  const box = sc(minTouchTarget);
  const content = <Icon name={props.icon} size={sc(props.size ?? 20)} color={props.variant === "sand" ? "onSand" : props.color ?? "textPrimary"} directional={props.directional} />;
  if (props.variant === "sand") {
    return (
      <PressScale onPress={props.onPress} disabled={props.disabled} accessibilityRole="button" accessibilityLabel={props.label} testID={props.testID} hitSlop={s(4)}
        innerStyle={{ alignItems: "center", gap: s(6), opacity: props.disabled === true ? 0.4 : 1 }}>
        <View style={{ width: controls.categoryDisc, height: controls.categoryDisc, borderRadius: controls.categoryDisc / 2, backgroundColor: colors.sand, alignItems: "center", justifyContent: "center" }}>{content}</View>
        {props.caption !== undefined ? <Text variant="caption" weight="500" numberOfLines={1} maxScale={1.3} align="center" style={{ maxWidth: s(76) }} accessibilityRole="none">{props.caption}</Text> : null}
      </PressScale>
    );
  }
  if (props.variant === "solid") {
    return (
      <PressScale onPress={props.onPress} disabled={props.disabled} accessibilityRole="button" accessibilityLabel={props.label} testID={props.testID} hitSlop={s(4)}
        innerStyle={{ width: box, height: box, alignItems: "center", justifyContent: "center", opacity: props.disabled === true ? 0.4 : 1 }}>
        <View style={{ width: controls.iconDisc, height: controls.iconDisc, borderRadius: controls.iconDisc / 2, backgroundColor: colors.surface, opacity: 0.94, alignItems: "center", justifyContent: "center" }}>{content}</View>
      </PressScale>
    );
  }
  return (
    <PressScale onPress={props.onPress} disabled={props.disabled} accessibilityRole="button" accessibilityLabel={props.label} testID={props.testID} hitSlop={s(4)}
      innerStyle={{ width: box, height: box, alignItems: "center", justifyContent: "center", opacity: props.disabled === true ? 0.4 : 1 }}>
      {props.variant === "glass" ? (
        <GlassSurface radius={controls.iconDisc / 2} intensity={glass.intensity.chip} {...(props.color === "onImage" ? { tint: colors.glassTintOnImage } : {})} innerStyle={{ width: controls.iconDisc, height: controls.iconDisc, alignItems: "center", justifyContent: "center" }}>{content}</GlassSurface>
      ) : content}
    </PressScale>
  );
}

/**
 * Top bar. `glass` frosts it over scrolling content / imagery; `title` can fade in via `titleOpacity`.
 * Respects the Dynamic Island: the status-bar inset is added to the top.
 */
export function AppBar(props: {
  title?: string | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  glass?: boolean | undefined;
  floating?: boolean | undefined;
  /** Scroll offset; the title fades in (40..80) and the glass background (10..50) as it grows. */
  scrollY?: SharedValue<number> | undefined;
}) {
  const { colors, labels, s, sc, controls } = useTheme();
  const insets = useSafeAreaInsets();
  const column = useContext(ColumnContext);
  const sy = props.scrollY;
  const titleStyle = useAnimatedStyle(() => ({ opacity: sy ? interpolate(sy.value, [40, 80], [0, 1], Extrapolation.CLAMP) : 1 }));
  const bgStyle = useAnimatedStyle(() => ({ opacity: sy ? interpolate(sy.value, [10, 50], [0, 1], Extrapolation.CLAMP) : 1 }));
  const row = (
    <View style={[{ paddingTop: insets.top, paddingHorizontal: s(6), minHeight: insets.top + controls.appBar, flexDirection: "row", alignItems: "center" }, column !== null ? { width: "100%", maxWidth: column, alignSelf: "center" } : null]}>
      <View style={{ minWidth: sc(minTouchTarget), alignItems: "flex-start" }}>
        {props.leading ?? (props.onBack ? <IconButton icon="arrow-back" directional label={props.backLabel ?? labels.back} onPress={props.onBack} /> : null)}
      </View>
      <Animated.View style={[{ flex: 1, alignItems: "center" }, titleStyle]}>
        {props.title !== undefined ? <Text variant="headline" weight="600" numberOfLines={1} accessibilityRole="header">{props.title}</Text> : null}
      </Animated.View>
      <View style={{ minWidth: sc(minTouchTarget), alignItems: "flex-end", flexDirection: "row", justifyContent: "flex-end" }}>{props.trailing}</View>
    </View>
  );
  const pos: ViewStyle | null = props.floating === true ? { position: "absolute", top: 0, start: 0, end: 0, zIndex: 10 } : null;
  if (props.glass === true) {
    return (
      <View style={pos}>
        <Animated.View style={[StyleSheet.absoluteFill, bgStyle]} pointerEvents="none"><GlassSurface edges="bottom" style={StyleSheet.absoluteFill} innerStyle={StyleSheet.absoluteFill} /></Animated.View>
        {row}
      </View>
    );
  }
  return <View style={[{ backgroundColor: colors.background }, pos]}>{row}</View>;
}

export interface TabBarItem {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  /** Filled glyph shown when selected. Defaults to the icon name without `-outline`. */
  readonly activeIcon?: IconName | undefined;
  readonly selected: boolean;
  readonly badge?: boolean | undefined;
  /** Live count shown in a pill (hidden at 0, capped at 99+). Takes precedence over `badge`. */
  readonly badgeCount?: number | undefined;
  /** Spoken suffix for the count, already localized (e.g. "3 items"). */
  readonly badgeLabel?: string | undefined;
  readonly onPress: () => void;
  readonly onLongPress?: (() => void) | undefined;
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}

/** Active tabs draw the filled glyph: an explicit `activeIcon`, else the Ionicons name without its `-outline` suffix. */
function activeGlyph(it: TabBarItem): IconName {
  if (it.activeIcon !== undefined) return it.activeIcon;
  const filled = it.icon.endsWith("-outline") ? (it.icon.slice(0, -8) as IconName) : it.icon;
  return filled in Ionicons.glyphMap ? filled : it.icon;
}

function TabCell(props: { item: TabBarItem }) {
  const { colors, s, sc, sized } = useTheme();
  const it = props.item;
  const count = tabBadgeText(it.badgeCount);
  const label = it.accessibilityLabel ?? it.label;
  return (
    <Pressable
      testID={it.testID}
      accessibilityRole="tab"
      accessibilityLabel={count !== null && it.badgeLabel !== undefined ? `${label}, ${it.badgeLabel}` : label}
      accessibilityState={{ selected: it.selected }}
      onPress={() => { if (!it.selected) selectionTick(); it.onPress(); }}
      onLongPress={it.onLongPress}
      style={{ flex: 1, minHeight: sc(minTouchTarget), alignItems: "center", justifyContent: "center", gap: s(3) }}
    >
      <View>
        <Icon name={it.selected ? activeGlyph(it) : it.icon} size={sc(22)} color={it.selected ? "textPrimary" : "textSecondary"} />
        {count !== null ? (
          <View style={{ position: "absolute", top: -s(5), end: -s(9), minWidth: s(14), height: s(14), paddingHorizontal: s(3), borderRadius: radii.pill, backgroundColor: colors.textPrimary, alignItems: "center", justifyContent: "center" }}>
            <Text variant="caption" weight="600" numeric numberOfLines={1} accessibilityRole="none" maxScale={1.1} style={{ ...sized(9, 11), color: colors.background }}>{count}</Text>
          </View>
        ) : it.badge === true ? <View style={{ position: "absolute", top: -s(1), end: -s(3), width: s(7), height: s(7), borderRadius: s(4), backgroundColor: colors.danger }} /> : null}
      </View>
      <Text variant="caption" weight={it.selected ? "600" : "400"} color={it.selected ? "textPrimary" : "textSecondary"} numberOfLines={1} accessibilityRole="none" maxScale={1.3} style={{ ...sized(10, 12), letterSpacing: 0 }}>{it.label}</Text>
    </Pressable>
  );
}

/**
 * Docked bar flush with the screen bottom: rounded top corners, hairline top edge, solid surface (also the
 * Reduce Transparency state). Filled glyph + bold ink label when active, muted outline otherwise.
 * Scenes clear it via TabBarInsetContext.
 */
export function TabBar(props: { items: readonly TabBarItem[] }) {
  return <SchemeScope scheme="light"><TabBarBody items={props.items} /></SchemeScope>;
}

function TabBarBody(props: { items: readonly TabBarItem[] }) {
  const insets = useSafeAreaInsets();
  const { colors, s, sc, layout } = useTheme();
  const cap = tabBarWidthCap(layout.sizeClass, layout.z);
  const bar = (
    <View
      accessibilityRole="tablist"
      style={{
        ...(cap === null ? { position: "absolute", start: 0, end: 0, bottom: 0 } as const : { width: "100%", maxWidth: cap } as const),
        height: sc(TAB_BAR_CONTENT_HEIGHT) + tabBarBottomPad(insets.bottom),
        paddingBottom: tabBarBottomPad(insets.bottom),
        flexDirection: "row", paddingHorizontal: s(6), paddingTop: s(4),
        backgroundColor: colors.background,
        borderTopStartRadius: s(20), borderTopEndRadius: s(20),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: colors.hairline,
      }}
    >
      {props.items.map((it) => <TabCell key={it.key} item={it} />)}
    </View>
  );
  // Regular and expanded: zoomed, centred, max 640 pt, still docked to the bottom edge.
  return cap === null ? bar : <View pointerEvents="box-none" style={{ position: "absolute", start: 0, end: 0, bottom: 0, alignItems: "center" }}>{bar}</View>;
}

/**
 * Bottom sheet on compact: glass panel, drag handle, drag-down to dismiss, tap backdrop to close.
 * On regular and expanded windows the same API renders a CENTRED FORM SHEET (no handle, visible close button, fade plus a
 * 0.98 to 1 scale, none under Reduce Motion): width min(420 eff, effective width - 2 gutters) * z, max height 85%.
 */
export function BottomSheet(props: { visible: boolean; onClose: () => void; children: ReactNode; title?: string | undefined; closeLabel?: string | undefined; maxHeightRatio?: number | undefined }) {
  const { colors, reduceMotion, s, sc, radii } = useTheme();
  const layout = useLayout();
  const insets = useSafeAreaInsets();
  const height = layout.windowHeight;
  const formWidth = formSheetWidth(layout.windowWidth);
  const [mounted, setMounted] = useState(props.visible);
  const y = useSharedValue(height);
  const dur = reduceMotion ? 0 : motion.base;
  const finish = useCallback(() => { setMounted(false); }, []);
  useEffect(() => {
    if (props.visible) { setMounted(true); y.value = withTiming(0, { duration: dur, easing: Easing.out(Easing.cubic) }); }
    else if (mounted) { y.value = withTiming(height, { duration: dur, easing: Easing.in(Easing.cubic) }, (done) => { if (done) runOnJS(finish)(); }); }
  }, [props.visible]);
  // Capture only the callback: a worklet that closes over `props` would try to copy `children` (React fibers).
  const onClose = props.onClose;
  const pan = useMemo(() => Gesture.Pan()
    .onChange((e) => { y.value = Math.max(0, y.value + e.changeY); })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) { runOnJS(onClose)(); }
      else { y.value = withTiming(0, { duration: motion.base, easing: Easing.out(Easing.cubic) }); }
    }), [onClose, y]);
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const backdrop = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [0, height], [1, 0], Extrapolation.CLAMP) }));
  // Form sheet: progress 0..1 from the same driver (inline math: worklets cannot call logic helpers).
  const form = useAnimatedStyle(() => {
    const p = interpolate(y.value, [height, 0], [0, 1], Extrapolation.CLAMP);
    return { opacity: p, transform: [{ scale: 0.98 + 0.02 * p }] };
  });
  if (!mounted) return null;
  if (formWidth !== null) {
    return (
      <Modal transparent visible animationType="none" onRequestClose={props.onClose} statusBarTranslucent supportedOrientations={["portrait", "landscape", "portrait-upside-down", "landscape-left", "landscape-right"]}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, backdrop]}>
            <Pressable accessibilityRole="button" accessibilityLabel={props.closeLabel ?? "Close"} style={StyleSheet.absoluteFill} onPress={props.onClose} />
          </Animated.View>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} pointerEvents="box-none" style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: insets.top, paddingBottom: s(16) }}>
            <Animated.View testID="form-sheet" style={[{ width: formWidth, maxHeight: formSheetMaxHeight(height) }, form]}>
              <GlassSurface intensity={glass.intensity.sheet} elevated radius={radii.xl}>
                <View style={{ position: "absolute", top: s(4), end: s(4), zIndex: 2 }}>
                  <IconButton icon="close" label={props.closeLabel ?? "Close"} onPress={props.onClose} />
                </View>
                <ScrollView bounces={false} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: s(16), paddingTop: s(16), paddingBottom: s(16), gap: s(14) }}>
                  {props.title !== undefined ? <View style={{ paddingEnd: sc(minTouchTarget) }}><Text variant="title2" accessibilityRole="header">{props.title}</Text></View> : <View style={{ height: sc(minTouchTarget) / 2 }} />}
                  {props.children}
                </ScrollView>
              </GlassSurface>
            </Animated.View>
          </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>
    );
  }
  return (
    <Modal transparent visible animationType="none" onRequestClose={props.onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, backdrop]}>
          <Pressable accessibilityRole="button" accessibilityLabel={props.closeLabel ?? "Close"} style={StyleSheet.absoluteFill} onPress={props.onClose} />
        </Animated.View>
        <Animated.View style={[{ maxHeight: height * (props.maxHeightRatio ?? 0.85) }, sheet]}>
          <GlassSurface intensity={glass.intensity.sheet} elevated radius={radii.xl} innerStyle={{ borderBottomStartRadius: 0, borderBottomEndRadius: 0 }}>
            <GestureDetector gesture={pan}>
              <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 6, minHeight: minTouchTarget / 2 }}>
                <View style={{ width: 36, height: 3, borderRadius: 2, backgroundColor: colors.textSecondary, opacity: 0.5 }} />
              </View>
            </GestureDetector>
            <View style={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 14 }}>
              {props.title !== undefined ? <Text variant="title2" accessibilityRole="header">{props.title}</Text> : null}
              {props.children}
            </View>
          </GlassSurface>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** Sticky bar for checkout totals / primary action, glass over scrolling content. Place as Screen `footer`. Content is capped to the screen's column. */
export function StickyBar(props: { children: ReactNode; density?: "compact" | "comfortable" | undefined }) {
  const insets = useSafeAreaInsets();
  const tabInset = useContext(TabBarInsetContext);
  const column = useContext(ColumnContext);
  const { s, layout } = useTheme();
  const tabPad = tabInset > 0 ? tabInset + tabBarZoomExtra(layout.z) : insets.bottom;
  const compact = props.density === "compact";
  return (
    <GlassSurface edges="top" elevated>
      <View style={[{ paddingHorizontal: s(16), paddingTop: compact ? s(8) : s(10), paddingBottom: Math.max(tabPad, compact ? s(8) : s(10)), gap: compact ? s(6) : s(8) }, column !== null && layout.sizeClass !== "compact" ? { width: "100%", maxWidth: column, alignSelf: "center" } : null]}>{props.children}</View>
    </GlassSurface>
  );
}

interface ToastItem { readonly id: number; readonly message: string; readonly kind: "info" | "success" | "error" }
interface ToastApi { show: (message: string, kind?: ToastItem["kind"]) => void }
const ToastContext = createContext<ToastApi>({ show: () => undefined });
export function useToast(): ToastApi { return useContext(ToastContext); }

/** Glass snackbar. Announces to screen readers; auto-dismisses after 3.2 s. Centred, max 384 eff (480 pt) on regular and expanded. */
export function ToastProvider(props: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const idRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const { colors, reduceMotion, s, layout, radii } = useTheme();
  const o = useSharedValue(0);
  const show = useCallback((message: string, kind: ToastItem["kind"] = "info") => {
    idRef.current += 1;
    setItem({ id: idRef.current, message, kind });
    o.value = withTiming(1, { duration: reduceMotion ? 0 : motion.base });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { o.value = withTiming(0, { duration: reduceMotion ? 0 : motion.base }, (d) => { if (d) runOnJS(setItem)(null); }); }, 3200);
  }, [o, reduceMotion]);
  const api = useMemo(() => ({ show }), [show]);
  const rise = s(12);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: interpolate(o.value, [0, 1], [rise, 0]) }] }));
  const dot = item?.kind === "error" ? colors.danger : item?.kind === "success" ? colors.savings : colors.textSecondary;
  const cap = toastWidthCap(layout.sizeClass, layout.z);
  return (
    <ToastContext.Provider value={api}>
      {props.children}
      {item !== null ? (
        <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" style={[{ position: "absolute", start: s(16), end: s(16), bottom: tabBarInset(insets.bottom) + tabBarZoomExtra(layout.z) + s(12), alignItems: "center" }, st]}>
          <GlassSurface radius={radii.md} elevated intensity={glass.intensity.sheet} style={cap !== null ? { maxWidth: cap } : undefined} innerStyle={{ paddingHorizontal: s(14), paddingVertical: s(10), flexDirection: "row", alignItems: "center", gap: s(8) }}>
            <View style={{ width: s(6), height: s(6), borderRadius: s(3), backgroundColor: dot }} />
            <Text variant="callout" accessibilityRole="alert" style={{ flexShrink: 1 }}>{item.message}</Text>
          </GlassSurface>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}
