import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Dimensions, I18nManager, View, useColorScheme, useWindowDimensions, type TextStyle } from "react-native";
import { colors as allColors, controlSize, gutter, radius, spacing, type ColorScheme, type ColorTokens, type TypeVariant } from "@outlet/ui-tokens";
import { previewDirection } from "./logic/rtl";
import { resolveScheme, type ThemePreference } from "./logic/misc";
import { textMetrics } from "./logic/type";
import { layoutFor, zoomInfoFor, zoomKey, zoomedTextMetrics, zoomedControlSize, zoomedRadii, zoomedSpacing, type LayoutInfo, type ZoomInfo } from "./logic/size-class";
import type { FontWeight } from "@outlet/ui-tokens";

export interface TextStyleOptions { readonly numeric?: boolean | undefined; readonly weight?: FontWeight | undefined }

export interface ThemeLabels {
  /** Accessible name of the AppBar back button. The kit has no English fallback. */
  readonly back: string;
}
const NO_LABELS: ThemeLabels = { back: "" };

export interface ThemeValue {
  readonly scheme: ColorScheme;
  readonly colors: ColorTokens;
  readonly isDark: boolean;
  readonly isRTL: boolean;
  readonly direction: "ltr" | "rtl";
  readonly preference: ThemePreference;
  readonly setPreference: (p: ThemePreference) => void;
  readonly fontsLoaded: boolean;
  readonly reduceMotion: boolean;
  readonly reduceTransparency: boolean;
  /** Zoomed on regular and expanded windows (identical to the tokens on compact). */
  readonly spacing: { readonly [K in keyof typeof spacing]: number };
  readonly radii: { readonly [K in keyof typeof radius]: number };
  /** Zoomed control sizes (button, field, chip ...); >= the compact value and >= 44 including slop. */
  readonly controls: { readonly [K in keyof typeof controlSize]: number };
  readonly gutter: number;
  /** Size class, zoom and `s(n)`: stable across resizes inside one zoom step. Window measurements: `useLayout()`. */
  readonly layout: ZoomInfo;
  /** round(n * z): the only way to scale a raw number. Identity on compact. */
  readonly s: (n: number) => number;
  /** round(n * controlZ): control heights and icon glyphs (1.45x at IPAD_ZOOM 1.725). */
  readonly sc: (n: number) => number;
  /** Zoomed {fontSize, lineHeight} for a fixed-size text override (chrome labels). Uses the same Dynamic Type fade-out as `type`. */
  readonly sized: (fontSize: number, lineHeight: number) => { readonly fontSize: number; readonly lineHeight: number };
  /** Localized strings the kit needs (injected by the app root; nested providers inherit). */
  readonly labels: ThemeLabels;
  /** Text style for a type variant, honouring Arabic metrics and loaded fonts. */
  readonly type: (variant: TypeVariant, opts?: TextStyleOptions) => TextStyle;
}

const ThemeContext = createContext<ThemeValue | null>(null);
/** Window-dependent layout values (width, height, content width, pane layout) change on every resize, so they live apart from the theme. */
const LayoutContext = createContext<LayoutInfo | null>(null);

function useA11yPrefs(): { reduceMotion: boolean; reduceTransparency: boolean } {
  const [reduceMotion, setRM] = useState(false);
  const [reduceTransparency, setRT] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setRM(v); }, () => undefined);
    void AccessibilityInfo.isReduceTransparencyEnabled().then((v) => { if (live) setRT(v); }, () => undefined);
    const a = AccessibilityInfo.addEventListener("reduceMotionChanged", setRM);
    const b = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setRT);
    return () => { live = false; a.remove(); b.remove(); };
  }, []);
  return { reduceMotion, reduceTransparency };
}

/** Zoomed metrics for a zoom step. At compact every value is the unzoomed token (regression-tested). */
function zoomParts(layout: ZoomInfo): Pick<ThemeValue, "spacing" | "radii" | "controls" | "gutter" | "layout" | "s" | "sc" | "sized"> {
  const sized: ThemeValue["sized"] = (fontSize, lineHeight) => {
    const m = zoomedTextMetrics({ fontSize, lineHeight, letterSpacing: 0 }, layout.z);
    return { fontSize: m.fontSize, lineHeight: m.lineHeight };
  };
  return layout.z === 1
    ? { spacing, radii: radius, controls: controlSize, gutter, layout, s: layout.s, sc: layout.sc, sized }
    : { spacing: zoomedSpacing(layout.z), radii: zoomedRadii(layout.z), controls: zoomedControlSize(layout.z), gutter: layout.gutter, layout, s: layout.s, sc: layout.sc, sized };
}

export function makeTypeFn(isRTL: boolean, fontsLoaded: boolean, z = 1): ThemeValue["type"] {
  return (variant, opts) => {
    const m = textMetrics(variant, { arabic: isRTL, fontsLoaded, numeric: opts?.numeric === true, zoom: z, ...(opts?.weight !== undefined ? { weight: opts.weight } : {}) });
    const style: TextStyle = { fontSize: m.fontSize, lineHeight: m.lineHeight, letterSpacing: m.letterSpacing, textTransform: m.textTransform };
    if (m.fontFamily !== undefined) style.fontFamily = m.fontFamily;
    if (m.tabularNums) style.fontVariant = ["tabular-nums"];
    return style;
  };
}

export interface ThemeProviderProps {
  /** Force a scheme (tests, previews). Wins over the preference. */
  readonly scheme?: ColorScheme | undefined;
  /** Controlled preference. Omit to let the provider hold it in state. */
  readonly preference?: ThemePreference | undefined;
  readonly onPreferenceChange?: ((p: ThemePreference) => void) | undefined;
  /** Layout direction for the active locale. Defaults to the native direction. */
  readonly isRTL?: boolean | undefined;
  readonly fontsLoaded?: boolean | undefined;
  /** Override the measured window (tests, previews). Omit in the app: the provider reads the live window. */
  readonly window?: { readonly width: number; readonly height?: number | undefined; readonly fontScale?: number | undefined } | undefined;
  /** Localized kit strings; a nested provider inherits the parent's when omitted. */
  readonly labels?: ThemeLabels | undefined;
  readonly children: ReactNode;
}

export function ThemeProvider(props: ThemeProviderProps) {
  const system = useColorScheme();
  const [localPref, setLocalPref] = useState<ThemePreference>("system");
  const preference = props.preference ?? localPref;
  const setPreference = useCallback((p: ThemePreference) => { setLocalPref(p); props.onPreferenceChange?.(p); }, [props]);
  const scheme = props.scheme ?? resolveScheme(preference, system === "dark" ? "dark" : "light");
  const isRTL = props.isRTL ?? I18nManager.isRTL;
  const fontsLoaded = props.fontsLoaded === true;
  const a11y = useA11yPrefs();
  const win = useWindowDimensions();
  const winWidth = props.window?.width ?? win.width;
  const winFontScale = props.window?.fontScale ?? win.fontScale;
  const winHeight = props.window?.height ?? win.height;
  const parentLabels = useContext(ThemeContext)?.labels;
  const labels = props.labels ?? parentLabels ?? NO_LABELS;
  // The theme depends on the size class, the zoom step and the font scale only: a resize inside one step keeps the same object.
  const zkey = zoomKey(winWidth, winFontScale);
  const zoomed = useMemo(() => zoomParts(zoomInfoFor(winWidth, winFontScale)), [zkey]);
  const value = useMemo<ThemeValue>(() => ({
    scheme, colors: allColors[scheme], isDark: scheme === "dark", isRTL, direction: isRTL ? "rtl" : "ltr",
    preference, setPreference, fontsLoaded, reduceMotion: a11y.reduceMotion, reduceTransparency: a11y.reduceTransparency,
    ...zoomed, labels, type: makeTypeFn(isRTL, fontsLoaded, zoomed.layout.z),
  }), [scheme, isRTL, preference, setPreference, fontsLoaded, labels, a11y.reduceMotion, a11y.reduceTransparency, zoomed]);
  const layout = useMemo(() => layoutFor(winWidth, winFontScale, winHeight), [winWidth, winFontScale, winHeight]);
  const dir = previewDirection(isRTL, I18nManager.isRTL);
  return (
    <ThemeContext.Provider value={value}>
      <LayoutContext.Provider value={layout}>
        <View style={dir === null ? { flex: 1 } : { flex: 1, direction: dir }}>{props.children}</View>
      </LayoutContext.Provider>
    </ThemeContext.Provider>
  );
}

/** Re-scopes descendants to a fixed colour scheme (surfaces that stay light in dark mode, e.g. the tab bar). */
export function SchemeScope(props: { readonly scheme: ColorScheme; readonly children: ReactNode }) {
  const parent = useTheme();
  const value = useMemo<ThemeValue>(() => ({ ...parent, scheme: props.scheme, colors: allColors[props.scheme], isDark: props.scheme === "dark" }), [parent, props.scheme]);
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  const system = useColorScheme();
  const scheme: ColorScheme = system === "dark" ? "dark" : "light";
  const isRTL = I18nManager.isRTL;
  // Without a provider (tests, previews) read the window once, without subscribing: the provider is the live path.
  return useMemo<ThemeValue>(() => {
    if (ctx !== null) return ctx;
    const w = Dimensions.get("window");
    const zi = zoomInfoFor(w.width, w.fontScale);
    return {
      scheme, colors: allColors[scheme], isDark: scheme === "dark", isRTL, direction: isRTL ? "rtl" : "ltr",
      preference: "system", setPreference: () => undefined, fontsLoaded: false, reduceMotion: false, reduceTransparency: false,
      ...zoomParts(zi), labels: NO_LABELS, type: makeTypeFn(isRTL, false, zi.z),
    };
  }, [ctx, scheme, isRTL]);
}

/** Size class, zoom `z`, effective width, content width, window size and `s(n)`. Screens use this instead of reading the window. */
export function useLayout(): LayoutInfo {
  const ctx = useContext(LayoutContext);
  return useMemo(() => {
    if (ctx !== null) return ctx;
    const w = Dimensions.get("window");
    return layoutFor(w.width, w.fontScale, w.height);
  }, [ctx]);
}
