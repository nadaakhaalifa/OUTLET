import { View } from "react-native";
import { Image } from "expo-image";
import { useTheme } from "../../ui";

/** Transparency checkerboard (token colours). Decorative: hidden from assistive tech. */
export function Checkerboard(props: { width: number; height: number; cell?: number; children?: React.ReactNode }) {
  const { colors } = useTheme();
  const cell = props.cell ?? 16;
  const cols = Math.ceil(props.width / cell);
  const rows = Math.ceil(props.height / cell);
  return (
    <View style={{ width: props.width, height: props.height, overflow: "hidden", borderRadius: 18, backgroundColor: colors.surface }}>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ position: "absolute", top: 0, start: 0, width: cols * cell, flexDirection: "row", flexWrap: "wrap" }}>
        {Array.from({ length: cols * rows }, (_v, i) => {
          const dark = (Math.floor(i / cols) + (i % cols)) % 2 === 0;
          return <View key={i} style={{ width: cell, height: cell, backgroundColor: dark ? colors.fill : colors.surface }} />;
        })}
      </View>
      {props.children}
    </View>
  );
}

/** The rounded arch-window studio backdrop (sand) a cutout sits on in the photo grid. */
export function ArchStudio(props: { uri: string; width: number; height: number; label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: props.width, height: props.height, borderRadius: 18, backgroundColor: colors.fill, overflow: "hidden", alignItems: "center", justifyContent: "flex-end" }}>
      <View style={{ width: props.width * 0.82, height: props.height * 0.9, borderTopStartRadius: props.width, borderTopEndRadius: props.width, backgroundColor: colors.sand, overflow: "hidden" }}>
        <Image source={{ uri: props.uri }} contentFit="contain" style={{ width: "100%", height: "100%" }} accessible={false} />
      </View>
    </View>
  );
}
