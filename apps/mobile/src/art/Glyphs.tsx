import { memo } from "react";
import { I18nManager } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { CATEGORY_ICONS, ILLUSTRATIONS, type CategoryName, type IllustrationName } from "./glyph-data";
import type { ArtTone } from "./palette";
import { toneColors, useArtTone } from "./tone";

export interface IllustrationProps {
  readonly name: IllustrationName;
  readonly size?: number;
  readonly tone?: ArtTone;
  /** Localised accessible label. Omit for purely decorative use. */
  readonly label?: string;
  readonly mirrorInRTL?: boolean;
}

function IllustrationImpl({ name, size = 120, tone, label, mirrorInRTL = false }: IllustrationProps) {
  const c = toneColors(useArtTone(tone));
  const def = ILLUSTRATIONS[name];
  const flip = mirrorInRTL && I18nManager.isRTL;
  const hidden = label === undefined;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      accessible={!hidden}
      {...(label !== undefined ? { accessibilityLabel: label, accessibilityRole: "image" as const } : {})}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "yes"}
    >
      <G transform={flip ? "translate(96 0) scale(-1 1)" : undefined} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {def.ink.map((d) => (
          <Path key={d} d={d} stroke={c.ink} />
        ))}
        {def.gold.map((d) => (
          <Path key={d} d={d} stroke={c.gold} />
        ))}
      </G>
    </Svg>
  );
}
export const Illustration = memo(IllustrationImpl);

export interface CategoryIconProps {
  readonly name: CategoryName;
  readonly size?: number;
  readonly color?: string;
  readonly tone?: ArtTone;
  readonly label?: string;
}

function CategoryIconImpl({ name, size = 24, color, tone, label }: CategoryIconProps) {
  const c = toneColors(useArtTone(tone));
  const hidden = label === undefined;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={!hidden}
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "yes"}
    >
      <G fill="none" stroke={color ?? c.ink} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        {CATEGORY_ICONS[name].map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </Svg>
  );
}
export const CategoryIcon = memo(CategoryIconImpl);
