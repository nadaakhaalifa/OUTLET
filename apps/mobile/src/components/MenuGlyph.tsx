import { I18nManager } from "react-native";
import Svg, { Line } from "react-native-svg";

/**
 * Menu glyph: two rounded strokes, a long one over a short one, anchored to the reading start edge.
 * Quieter and more editorial than the three-bar hamburger; mirrors in RTL so the short stroke stays at the start.
 */
export function MenuGlyph(props: { color: string; size?: number }) {
  const size = props.size ?? 24;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ transform: [{ scaleX: I18nManager.isRTL ? -1 : 1 }] }}
    >
      <Line x1="3" y1="8.5" x2="21" y2="8.5" stroke={props.color} strokeWidth={1.7} strokeLinecap="round" />
      <Line x1="3" y1="15.5" x2="14.5" y2="15.5" stroke={props.color} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}
