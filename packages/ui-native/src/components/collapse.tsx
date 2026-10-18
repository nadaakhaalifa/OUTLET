import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useTheme } from "../theme";
import { COLLAPSE_A11Y_HIDE_BELOW, collapseEnabled, decideCollapse, INITIAL_COLLAPSE, type CollapseState } from "../logic/collapse";

/** Visibility of a collapsible header, driven by a list's scroll direction. Wire the handlers to the list (scrollEventThrottle 16). */
export interface ScrollCollapse {
  /** 1 = header shown, 0 = hidden. */
  readonly progress: SharedValue<number>;
  readonly onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Lets the hook skip hiding on lists too short to scroll the header's height. Pass to the list's `onContentSizeChange`. */
  readonly onContentSizeChange: (width: number, height: number) => void;
  /** Pass to the list's `onLayout` (viewport height). */
  readonly onLayout: (e: LayoutChangeEvent) => void;
  /** Called by `CollapseOnScroll` with the header's natural height. */
  readonly setHeaderHeight: (height: number) => void;
  /** Call when the list remounts or is replaced by another body, so the header comes back. */
  readonly reset: () => void;
  /** False for screen reader and Reduce Motion users: the header never collapses. */
  readonly enabled: boolean;
}

const DURATION_MS = 220;

function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled().then((v) => { if (live) setOn(v); }, () => undefined);
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => { live = false; sub.remove(); };
  }, []);
  return on;
}

export function useScrollCollapse(): ScrollCollapse {
  const { reduceMotion } = useTheme();
  const screenReader = useScreenReader();
  const enabled = collapseEnabled(reduceMotion, screenReader);
  const progress = useSharedValue(1);
  const state = useRef<CollapseState>(INITIAL_COLLAPSE);
  const sizes = useRef<{ content: number | null; viewport: number | null; header: number }>({ content: null, viewport: null, header: 0 });
  const animate = useCallback((shown: boolean) => {
    progress.value = withTiming(shown ? 1 : 0, { duration: DURATION_MS, easing: Easing.out(Easing.cubic) });
  }, [progress]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!enabled) return;
    const d = decideCollapse(state.current, {
      rawY: e.nativeEvent.contentOffset.y, now: Date.now(),
      contentHeight: sizes.current.content, viewportHeight: sizes.current.viewport, headerHeight: sizes.current.header,
    });
    state.current = d.state;
    if (d.action !== "none") animate(d.action === "show");
  }, [enabled, animate]);
  const onContentSizeChange = useCallback((_w: number, h: number) => { sizes.current.content = h; }, []);
  const onLayout = useCallback((e: LayoutChangeEvent) => { sizes.current.viewport = e.nativeEvent.layout.height; }, []);
  const setHeaderHeight = useCallback((h: number) => { sizes.current.header = h; }, []);
  const reset = useCallback(() => { state.current = INITIAL_COLLAPSE; progress.value = 1; }, [progress]);
  // Turning a screen reader or Reduce Motion on while hidden brings the header back at once.
  useEffect(() => { if (!enabled) reset(); }, [enabled, reset]);
  return useMemo(
    () => ({ progress, onScroll, onContentSizeChange, onLayout, setHeaderHeight, reset, enabled }),
    [progress, onScroll, onContentSizeChange, onLayout, setHeaderHeight, reset, enabled],
  );
}

/**
 * Header that fades out and collapses its height when the list scrolls down, leaving only the items,
 * and returns as soon as the list scrolls up (or is back at the top). Natural height is measured once laid out.
 * While collapsed its children leave the accessibility tree (they are invisible and must not be focusable).
 */
export function CollapseOnScroll(props: { scroll: ScrollCollapse; children: ReactNode }) {
  const [natural, setNatural] = useState<number | null>(null);
  const [hiddenFromAT, setHiddenFromAT] = useState(false);
  const progress = props.scroll.progress;
  const style = useAnimatedStyle(() => {
    if (natural === null) return {};
    return { height: natural * progress.value, opacity: progress.value, overflow: "hidden" as const };
  }, [natural]);
  // Inline comparison: worklets cannot call plain JS helpers (calling headerHiddenFromAssistive here aborted the app
  // natively on the UI runtime). logic/collapse.ts headerHiddenFromAssistive is the tested twin; the constant is copied by value.
  const hideBelow = COLLAPSE_A11Y_HIDE_BELOW;
  useAnimatedReaction(
    () => progress.value < hideBelow,
    (hidden, prev) => { if (hidden !== prev) runOnJS(setHiddenFromAT)(hidden); },
    [],
  );
  return (
    <Animated.View style={style} accessibilityElementsHidden={hiddenFromAT} importantForAccessibility={hiddenFromAT ? "no-hide-descendants" : "auto"}>
      <View onLayout={(e) => { const h = Math.ceil(e.nativeEvent.layout.height); setNatural(h); props.scroll.setHeaderHeight(h); }}>{props.children}</View>
    </Animated.View>
  );
}
