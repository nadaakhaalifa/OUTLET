/**
 * Wallpaper texture: one static, tileable paper/linen grain mounted once at the root.
 * Dark grain on the ivory (light) theme, light grain on the ink-teal (dark) theme. Touch-transparent, hidden from
 * accessibility, no animation and no state, so it never repaints. Dev-only off switch: EXPO_PUBLIC_DISABLE_TEXTURE=1.
 */
import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTheme } from "@outlet/ui-native";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro static asset
const DARK_GRAIN = require("../../assets/textures/paper-dark.png") as number;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro static asset
const LIGHT_GRAIN = require("../../assets/textures/paper-light.png") as number;

// Alpha stays low so photography is not dulled and text contrast pairs are unchanged in practice (<~3% luminance).
const OPACITY_ON_LIGHT = 0.06;
const OPACITY_ON_DARK = 0.045;

export function LuxuryTexture() {
  const { isDark } = useTheme();
  const { width, height } = useWindowDimensions();
  if (__DEV__ && process.env["EXPO_PUBLIC_DISABLE_TEXTURE"] === "1") return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Image
        source={isDark ? LIGHT_GRAIN : DARK_GRAIN}
        resizeMode="repeat"
        style={[{ width, height, opacity: isDark ? OPACITY_ON_DARK : OPACITY_ON_LIGHT }]}
      />
    </View>
  );
}
