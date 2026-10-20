// Campaign backgrounds. No text is baked in: screens overlay AR/EN copy.
import { memo, useId, useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { HERO_H, HERO_W, heroSpec, type HeroVariant } from "./art-geometry";
import { grainPaths, WHITE, BLACK } from "./palette";

export interface HeroArtProps {
  readonly variant: HeroVariant;
  readonly aspect?: number;
  readonly style?: StyleProp<ViewStyle>;
}

function HeroArtImpl({ variant, aspect = HERO_W / HERO_H, style }: HeroArtProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const spec = useMemo(() => heroSpec(variant), [variant]);
  const grain = useMemo(() => grainPaths(`hero:${variant}`, HERO_W, HERO_H, 900, 0.4), [variant]);
  return (
    <View style={[{ aspectRatio: aspect, width: "100%", overflow: "hidden" }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%" viewBox={`0 0 ${HERO_W} ${HERO_H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={spec.stops[0]} />
            <Stop offset="0.55" stopColor={spec.stops[1]} />
            <Stop offset="1" stopColor={spec.stops[2]} />
          </LinearGradient>
          <RadialGradient id={`${uid}glow`} cx="78%" cy="18%" rx="60%" ry="80%">
            <Stop offset="0" stopColor={WHITE} stopOpacity="0.22" />
            <Stop offset="1" stopColor={WHITE} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id={`${uid}vig`} cx="50%" cy="50%" rx="75%" ry="85%">
            <Stop offset="0.5" stopColor={BLACK} stopOpacity="0" />
            <Stop offset="1" stopColor={BLACK} stopOpacity="0.38" />
          </RadialGradient>
        </Defs>
        <Rect width={HERO_W} height={HERO_H} fill={`url(#${uid}g)`} />
        {spec.layers.map((l, i) => (
          <Path key={i} d={l.d} opacity={l.opacity} {...(l.stroke ? { fill: "none", stroke: l.fill, strokeWidth: l.stroke } : { fill: l.fill })} />
        ))}
        <Rect width={HERO_W} height={HERO_H} fill={`url(#${uid}glow)`} />
        <Rect width={HERO_W} height={HERO_H} fill={`url(#${uid}vig)`} />
        <Path d={grain.light} fill={WHITE} opacity={0.15} />
        <Path d={grain.dark} fill={BLACK} opacity={0.14} />
      </Svg>
    </View>
  );
}
export const HeroArt = memo(HeroArtImpl);
