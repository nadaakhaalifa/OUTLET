/**
 * Woven grey-brown fabric backdrop for the stores directory. Light theme only (dark keeps its flat ink background).
 * Static, tileable, touch-transparent and hidden from accessibility. The texture is generated in-house (plain weave),
 * not a copy of any third-party image. Text contrast pairs are checked against the lightest and darkest threads.
 */
import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTheme } from "@outlet/ui-native";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro static asset
const FABRIC = require("../../assets/textures/fabric-taupe.png") as number;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro static asset
const FABRIC_SOFT = require("../../assets/textures/fabric-taupe-light.png") as number;

/** `soft` is the same weave in a much lighter tone, for list screens. */
/** The soft weave is faded into the page background so it reads as a hint of texture. */
const SOFT_OPACITY = 0.45;

export function FabricBackdrop(props: { soft?: boolean }) {
  const { isDark } = useTheme();
  const { width, height } = useWindowDimensions();
  if (isDark) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Image source={props.soft === true ? FABRIC_SOFT : FABRIC} resizeMode="repeat" style={{ width, height, opacity: props.soft === true ? SOFT_OPACITY : 1 }} />
    </View>
  );
}
