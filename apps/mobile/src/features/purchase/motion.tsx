import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, LinearTransition } from "react-native-reanimated";
import { motion } from "@outlet/ui-tokens";
import { useEntering, useTheme } from "../../ui";

const [ea, eb, ec, ed] = motion.easing.standard;

/**
 * Transaction-flow motion helpers. Transform, opacity and layout animations only; all disabled under Reduce Motion.
 * Entering/exiting/layout builders are configured at render time and never run plain JS inside a worklet.
 */

/** List item: staggered reveal on first mount, soft layout glide when siblings change, quick fade on removal. */
export function Flow(props: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { reduceMotion } = useTheme();
  const entering = useEntering(props.index ?? 0);
  return (
    <Animated.View
      {...(entering !== undefined ? { entering } : {})}
      {...(!reduceMotion
        ? { layout: LinearTransition.duration(motion.base).easing(Easing.bezier(ea, eb, ec, ed)), exiting: FadeOut.duration(motion.fast) }
        : {})}
      style={props.style}
    >
      {props.children}
    </Animated.View>
  );
}

/** Slow settle for a success moment: rises 12pt and fades in over the hero duration. */
export function Settle(props: { delay?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { reduceMotion } = useTheme();
  const entering = reduceMotion
    ? undefined
    : FadeInDown.delay(props.delay ?? 0).duration(motion.hero).easing(Easing.bezier(ea, eb, ec, ed))
      .withInitialValues({ opacity: 0, transform: [{ translateY: 12 }] });
  return <Animated.View {...(entering !== undefined ? { entering } : {})} style={props.style}>{props.children}</Animated.View>;
}

/** Cross-fades when `value` changes (totals, line prices): the node remounts under a new key and fades in. */
export function ValueFade(props: { value: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { reduceMotion } = useTheme();
  return (
    <Animated.View key={props.value} {...(!reduceMotion ? { entering: FadeIn.duration(motion.base) } : {})} style={props.style}>
      {props.children}
    </Animated.View>
  );
}
