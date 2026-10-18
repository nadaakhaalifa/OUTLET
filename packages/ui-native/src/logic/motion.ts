import { motion } from "@outlet/ui-tokens";
import { clamp01 } from "./misc";

/** Delay (ms) before item `index` of a staggered list starts; items past `stagger.max` share the last slot. */
export function staggerDelay(index: number): number {
  const i = Math.max(0, Math.min(Math.floor(Number.isFinite(index) ? index : 0), motion.stagger.max));
  return i * motion.stagger.step;
}

export interface EntranceSpec {
  readonly delay: number;
  readonly duration: number;
  /** Starting translateY in points. */
  readonly distance: number;
}

/** Entrance spec for list item `index`, or null when Reduce Motion is on (render immediately). */
export function entranceSpec(index: number, reduceMotion: boolean): EntranceSpec | null {
  if (reduceMotion) return null;
  return { delay: staggerDelay(index), duration: motion.stagger.duration, distance: motion.stagger.distance };
}

/** 0..1 progress of the large title collapsing into the app bar. */
export function collapseProgress(scrollY: number, distance = 72): number {
  return clamp01(scrollY / distance);
}

/** Hero parallax: image drifts at 40% of scroll speed; pulling down (negative y) scales it up to fill. */
export function heroParallax(scrollY: number, height: number): { translateY: number; scale: number } {
  if (scrollY < 0) return { translateY: scrollY / 2, scale: 1 + Math.min(-scrollY, height) / height };
  return { translateY: scrollY * 0.4, scale: 1 };
}

/** Easing control points as the 4-tuple `Easing.bezier` expects. */
export function bezier(name: keyof typeof motion.easing): readonly [number, number, number, number] {
  const e = motion.easing[name];
  return [e[0], e[1], e[2], e[3]];
}

/** Press feedback target: scale, honouring Reduce Motion (no scale, opacity dip only). */
export function pressFeedback(reduceMotion: boolean, scale: number = motion.pressScale): { scale: number; opacity: number } {
  return reduceMotion ? { scale: 1, opacity: 0.7 } : { scale, opacity: 0.92 };
}
