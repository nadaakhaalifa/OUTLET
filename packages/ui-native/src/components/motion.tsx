import { createContext, useContext, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { Easing, FadeInDown, type SharedValue } from "react-native-reanimated";
import { useTheme } from "../theme";
import { bezier, entranceSpec } from "../logic/motion";

/** Scroll offset of the enclosing Screen (null outside a Screen). Heroes and bars read it for scroll-linked motion. */
export const ScrollYContext = createContext<SharedValue<number> | null>(null);
export function useScrollY(): SharedValue<number> | null {
  return useContext(ScrollYContext);
}

/**
 * Reanimated `entering` value for list item `index`: fade + 16pt rise, 60 ms stagger (capped at 8 items),
 * eased with the standard curve. Transform and opacity only. Returns undefined under Reduce Motion.
 */
export function useEntering(index: number): ReturnType<typeof FadeInDown.duration> | undefined {
  const { reduceMotion } = useTheme();
  const spec = entranceSpec(index, reduceMotion);
  if (spec === null) return undefined;
  const [a, b, c, d] = bezier("standard");
  return FadeInDown.delay(spec.delay).duration(spec.duration).easing(Easing.bezier(a, b, c, d))
    .withInitialValues({ opacity: 0, transform: [{ translateY: spec.distance }] });
}

/** Wrap list items: `<Reveal index={i}>…</Reveal>` gives the signature staggered entrance. */
export function Reveal(props: { index?: number | undefined; children: ReactNode; style?: StyleProp<ViewStyle> | undefined }) {
  const entering = useEntering(props.index ?? 0);
  return <Animated.View {...(entering !== undefined ? { entering } : {})} style={props.style}>{props.children}</Animated.View>;
}
