import { useMemo, useRef, type ReactNode } from "react";
import { LayoutAnimation, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector, type GestureType } from "react-native-gesture-handler";
import { motion } from "@outlet/ui-tokens";
import { useTheme } from "../../ui";
import { pinchToDensity, type Density } from "./model";

export { anchorIndexAfterChange } from "./model";

/**
 * Call right before the density state changes so the relayout animates, unless Reduce Motion is on (then it is
 * instant). Geometry animation can be janky on Android and is not source-verified: if it misbehaves on device,
 * replace with an opacity cross-fade.
 */
export function animateDensityChange(reduceMotion: boolean): void {
  if (reduceMotion) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(motion.fast, "easeInEaseOut", "opacity"));
}

export interface PinchToDensityProps {
  density: Density;
  /** Highest density allowed (font-scale cap). */
  max?: Density | undefined;
  onChange: (next: Density) => void;
  /** The list's native scroll gesture, if the list exposes one, so pinch runs simultaneously with scrolling. */
  scrollGesture?: GestureType | undefined;
  children: ReactNode;
  style?: StyleProp<ViewStyle> | undefined;
}

/**
 * Two-finger pinch wrapper for the product grid. Pitfalls (see docs/research/research_notes/Product grid density
 * and filters/pitfalls_and_risks.md):
 * - Wrap ONLY the vertical product list. Keep chip rows, the filter bar and any horizontal carousel OUTSIDE this
 *   view, or they will contest horizontal pans.
 * - One step per gesture: once the threshold is crossed we fire and ignore the rest until the fingers lift, so the
 *   density cannot oscillate.
 * - Changing numColumns remounts cells and can lose the scroll position. Before changing, record the first visible
 *   item id (onViewableItemsChanged); after, scrollToIndex(anchorIndexAfterChange(items, id)) on the next frame.
 * - Heart/wishlist state must come from a store keyed by product id, not cell state (recycling resets it).
 * - Android pinch inside a scroll container has had bugs: verify on a device; the toggle button is the guaranteed
 *   path (WCAG 2.5.1).
 */
export function PinchToDensity(props: PinchToDensityProps) {
  const { reduceMotion } = useTheme();
  const fired = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const rm = useRef(reduceMotion);
  rm.current = reduceMotion;

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(() => { fired.current = false; })
      .onUpdate((e) => {
        if (fired.current) return;
        const { density, max, onChange } = latest.current;
        const next = pinchToDensity(density, e.scale, max ?? 4);
        if (next === density) return;
        fired.current = true;
        animateDensityChange(rm.current);
        onChange(next);
      })
      .onFinalize(() => { fired.current = false; });
    return props.scrollGesture !== undefined ? pinch.simultaneousWithExternalGesture(props.scrollGesture) : pinch;
  }, [props.scrollGesture]);

  return <GestureDetector gesture={gesture}><View style={props.style} collapsable={false}>{props.children}</View></GestureDetector>;
}
