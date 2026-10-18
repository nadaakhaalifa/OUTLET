// PLACEHOLDER ART: abstract store banners and monogram badges (not store logos).
import { colors } from "@outlet/ui-tokens";
import { memo, useId, useMemo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { COVER_H, COVER_W, coverLayers, initialOf } from "./art-geometry";
import { darken, grainPaths, lighten, mix, paletteFor, type ArtTone, WHITE, BLACK, DEEP, ABYSS } from "./palette";
import { useArtTone } from "./tone";

export interface StoreCoverProps {
  readonly seed: string | number;
  /** width / height, default 2.5. */
  readonly aspect?: number;
  readonly tone?: ArtTone;
  readonly style?: StyleProp<ViewStyle>;
}

function StoreCoverImpl({ seed, aspect = COVER_W / COVER_H, tone, style }: StoreCoverProps) {
  const t = useArtTone(tone);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { palette, layers } = useMemo(() => coverLayers(seed), [seed]);
  const grain = useMemo(() => grainPaths(`cover:${seed}`, COVER_W, COVER_H, 420), [seed]);
  const top = t === "dark" ? mix(palette.deep, DEEP, 0.55) : lighten(palette.base, 0.25);
  const bottom = t === "dark" ? mix(palette.deep, ABYSS, 0.7) : palette.base;
  return (
    <View style={[{ aspectRatio: aspect, width: "100%", overflow: "hidden" }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%" viewBox={`0 0 ${COVER_W} ${COVER_H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={top} />
            <Stop offset="1" stopColor={bottom} />
          </LinearGradient>
          <LinearGradient id={`${uid}d`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={BLACK} stopOpacity="0" />
            <Stop offset="1" stopColor={BLACK} stopOpacity={t === "dark" ? 0.5 : 0.28} />
          </LinearGradient>
          <RadialGradient id={`${uid}s`} cx="28%" cy="20%" rx="70%" ry="90%">
            <Stop offset="0" stopColor={WHITE} stopOpacity={t === "dark" ? 0.14 : 0.4} />
            <Stop offset="1" stopColor={WHITE} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width={COVER_W} height={COVER_H} fill={`url(#${uid}g)`} />
        <G>
          {layers.map((l, i) => (
            <Path key={i} d={l.d} fill={l.fill} opacity={l.opacity} {...(l.stroke ? { stroke: WHITE, strokeWidth: l.stroke, strokeOpacity: 0.25 } : {})} />
          ))}
        </G>
        <Rect width={COVER_W} height={COVER_H} fill={`url(#${uid}s)`} />
        <Rect width={COVER_W} height={COVER_H} fill={`url(#${uid}d)`} />
        <Path d={grain.light} fill={WHITE} opacity={0.16} />
        <Path d={grain.dark} fill={BLACK} opacity={0.14} />
      </Svg>
    </View>
  );
}
export const StoreCover = memo(StoreCoverImpl);

export interface StoreAvatarProps {
  readonly name: string;
  readonly seed?: string | number;
  readonly size?: number;
  readonly tone?: ArtTone;
}

/** Perceptual-ish luminance of #RRGGBB (0..1), enough to pick a legible initial colour. */
function relLum(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})/.exec(hex);
  if (m === null || m[1] === undefined) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function StoreAvatarImpl({ name, seed, size = 44, tone }: StoreAvatarProps) {
  const t = useArtTone(tone);
  const p = paletteFor(seed ?? name);
  const bg = t === "dark" ? mix(p.deep, DEEP, 0.35) : p.base;
  const lum = relLum(bg);
  const fg = lum < 0.45 ? lighten(bg, 0.8) : t === "dark" ? lighten(p.base, 0.5) : darken(p.deep, 0.45);
  const rounded = size / 2;
  return (
    <View
      accessibilityLabel={name}
      accessibilityRole="image"
      style={{ width: size, height: size, borderRadius: rounded, backgroundColor: bg, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors[t].hairline }}
    >
      <Text allowFontScaling={false} style={{ color: fg, fontSize: size * 0.44, fontFamily: "PlayfairDisplay_500Medium", includeFontPadding: false }}>
        {initialOf(name)}
      </Text>
    </View>
  );
}
export const StoreAvatar = memo(StoreAvatarImpl);

export { initialOf };
