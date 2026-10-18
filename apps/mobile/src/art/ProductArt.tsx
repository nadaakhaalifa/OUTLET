// PLACEHOLDER ART: procedural product imagery until real photographs exist. Not a photograph, never shown as one.
import { memo, useId, useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { backdropFor, darken, grainPaths, hashSeed, lighten, mix, paletteFor, ratioValue, viewBoxFor, type ArtRatio, type ArtTone, WHITE, BLACK, INK } from "./palette";
import { BOX, shapeFor, type ProductKind, type ShapeLayer } from "./product-shapes";
import { useArtTone } from "./tone";

export interface ProductArtProps {
  readonly kind: ProductKind;
  readonly seed: string | number;
  readonly ratio?: ArtRatio;
  readonly tone?: ArtTone;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityLabel?: string;
}

const FLOOR: Partial<Record<ProductKind, number>> = { sneaker: 0.8, heel: 0.9, cap: 0.7, belt: 0.55, watch: 0.97, sunglasses: 0.68, scarf: 0.9, bag: 0.93 };
const isStroke = (d: string): boolean => !/[Zz]/.test(d);

function fillFor(layer: ShapeLayer, c: { base: string; base2: string; accent: string; sole: string }): string {
  switch (layer.role) {
    case "base": return c.base;
    case "base2": return c.base2;
    case "accent": return c.accent;
    case "sole": return c.sole;
    case "shade": return BLACK;
    case "light": return WHITE;
    case "glass": return "#1B1A1E";
    case "line": return BLACK;
  }
}

function ProductArtImpl({ kind, seed, ratio = "3:4", tone, style, accessibilityLabel }: ProductArtProps) {
  const t = useArtTone(tone);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { palette, layers, scale, tx, ty, vb } = useMemo(() => {
    const p = paletteFor(seed);
    const box = viewBoxFor(ratio);
    const s = (Math.min(box.width, box.height) * 0.82) / BOX;
    return {
      palette: p,
      layers: shapeFor(kind, hashSeed(`${seed}:${kind}`) % 4),
      scale: s,
      tx: (box.width - BOX * s) / 2,
      ty: (box.height - BOX * s) / 2 - box.height * 0.03,
      vb: box,
    };
  }, [kind, seed, ratio]);

  const bd = backdropFor(palette, t);
  const grain = useMemo(() => grainPaths(`${seed}:${kind}`, vb.width, vb.height, 520), [seed, kind, vb.width, vb.height]);
  // Duotone studio set: a tall arch window and a floor plane tinted from the palette's deep tone.
  const archW = vb.width * 0.74;
  const archX = (vb.width - archW) / 2;
  const archTop = vb.height * 0.1;
  const floorY = ty + BOX * scale * (FLOOR[kind] ?? 0.97);
  const setTone = t === "light" ? palette.deep : lighten(palette.base, 0.2);
  const colors = {
    base: t === "dark" ? lighten(palette.base, 0.04) : palette.base,
    base2: darken(palette.base, 0.12),
    accent: palette.accent,
    sole: t === "dark" ? "#EFE8DA" : "#F6F1E7",
  };
  const aspect = ratioValue(ratio);
  const hidden = accessibilityLabel === undefined;

  return (
    <View
      style={[{ aspectRatio: aspect, width: "100%", overflow: "hidden" }, style]}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "yes"}
      accessible={!hidden}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={hidden ? undefined : "image"}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${vb.width} ${vb.height}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id={`${uid}bg`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={bd.top} />
            <Stop offset="0.72" stopColor={bd.bottom} />
            <Stop offset="1" stopColor={darken(bd.bottom, t === "light" ? 0.06 : 0.2)} />
          </LinearGradient>
          <LinearGradient id={`${uid}sh`} x1="0" y1="0" x2="0.6" y2="1">
            <Stop offset="0" stopColor={WHITE} stopOpacity="0.28" />
            <Stop offset="0.5" stopColor={WHITE} stopOpacity="0" />
            <Stop offset="1" stopColor={BLACK} stopOpacity="0.2" />
          </LinearGradient>
          <RadialGradient id={`${uid}spot`} cx="50%" cy="44%" rx="62%" ry="52%">
            <Stop offset="0" stopColor={t === "light" ? WHITE : mix(palette.accent, WHITE, 0.2)} stopOpacity={t === "light" ? 0.7 : 0.22} />
            <Stop offset="1" stopColor={WHITE} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id={`${uid}vig`} cx="50%" cy="46%" rx="75%" ry="72%">
            <Stop offset="0.55" stopColor={BLACK} stopOpacity="0" />
            <Stop offset="1" stopColor={palette.deep} stopOpacity={t === "light" ? 0.3 : 0.55} />
          </RadialGradient>
          <LinearGradient id={`${uid}arch`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={setTone} stopOpacity={t === "light" ? 0.34 : 0.16} />
            <Stop offset="1" stopColor={setTone} stopOpacity="0.04" />
          </LinearGradient>
          <LinearGradient id={`${uid}floor`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.deep} stopOpacity="0" />
            <Stop offset="1" stopColor={palette.deep} stopOpacity={t === "light" ? 0.3 : 0.5} />
          </LinearGradient>
        </Defs>
        <Rect width={vb.width} height={vb.height} fill={`url(#${uid}bg)`} />
        <Path d={`M${archX} ${vb.height}V${archTop + archW / 2}A${archW / 2} ${archW / 2} 0 0 1 ${archX + archW} ${archTop + archW / 2}V${vb.height}Z`} fill={`url(#${uid}arch)`} />
        <Rect width={vb.width} height={vb.height} fill={`url(#${uid}spot)`} />
        <Rect y={floorY - vb.height * 0.02} width={vb.width} height={vb.height} fill={`url(#${uid}floor)`} />
        <Ellipse
          cx={vb.width / 2}
          cy={floorY}
          rx={BOX * scale * 0.38}
          ry={BOX * scale * 0.05}
          fill={BLACK}
          opacity={t === "light" ? 0.12 : 0.35}
        />
        <G transform={`translate(${tx} ${ty}) scale(${scale})`}>
          {layers.map((l, i) => {
            const fill = fillFor(l, colors);
            if (isStroke(l.d)) {
              const stroke = l.role === "line" ? (t === "dark" ? WHITE : INK) : fill;
              return (
                <Path key={i} d={l.d} fill="none" stroke={stroke} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={l.opacity ?? 1} />
              );
            }
            return (
              <G key={i}>
                <Path d={l.d} fill={fill} opacity={l.opacity ?? 1} />
                {l.shine === true ? <Path d={l.d} fill={`url(#${uid}sh)`} /> : null}
              </G>
            );
          })}
        </G>
        <Rect width={vb.width} height={vb.height} fill={`url(#${uid}vig)`} />
        <Path d={grain.light} fill={WHITE} opacity={0.16} />
        <Path d={grain.dark} fill={BLACK} opacity={0.14} />
      </Svg>
    </View>
  );
}

export const ProductArt = memo(ProductArtImpl);
