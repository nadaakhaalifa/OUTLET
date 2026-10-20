import { memo } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { ArtTone } from "./palette";
import { MONOGRAM_EYELET, MONOGRAM_Z, wordmarkGeometry } from "./brand-geometry";
import { toneColors, useArtTone } from "./tone";

export interface BrandProps {
  readonly size?: number;
  readonly tone?: ArtTone;
  /** Draw on the brand surface instead of transparent. */
  readonly filled?: boolean;
  readonly accessibilityLabel?: string;
}

const WM = wordmarkGeometry();

function MonogramImpl({ size = 48, tone, filled = false, accessibilityLabel = "Z-OUTLET" }: BrandProps) {
  const c = toneColors(useArtTone(tone));
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel={accessibilityLabel} accessible>
      {filled ? <Rect width={100} height={100} rx={22} fill={c.paper} /> : null}
      <Path d={MONOGRAM_Z} fill={c.ink} />
      <Circle cx={MONOGRAM_EYELET.cx} cy={MONOGRAM_EYELET.cy} r={MONOGRAM_EYELET.r} fill={c.brand} />
    </Svg>
  );
}

function WordmarkImpl({ size = 22, tone, accessibilityLabel = "Z-OUTLET" }: BrandProps) {
  const c = toneColors(useArtTone(tone));
  const w = (WM.width / WM.height) * size;
  return (
    <Svg width={w} height={size} viewBox={`-1 -1 ${WM.width + 2} ${WM.height + 2}`} accessibilityLabel={accessibilityLabel} accessible>
      {WM.parts.map((p, i) => {
        const color = p.accent === true ? c.brand : c.ink;
        return p.w === 0
          ? <Path key={i} d={p.d} fill={color} fillRule={p.evenodd === true ? "evenodd" : "nonzero"} />
          : <Path key={i} d={p.d} fill="none" stroke={color} strokeWidth={p.w} />;
      })}
    </Svg>
  );
}

/** Playfair Z monogram with a teal (sand on dark) full stop. `tone="dark"` is the inverse (ivory on deep teal). */
export const Monogram = memo(MonogramImpl);
/** Wide-tracked Playfair Z-OUTLET wordmark (outlined glyphs, teal hyphen); `size` is the height. */
export const Wordmark = memo(WordmarkImpl);
