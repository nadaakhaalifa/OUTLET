import { View } from "react-native";
import { radius } from "@outlet/ui-tokens";
import { ProductArt } from "../../art";
import { kindForTitle } from "./art-kind";

/** Placeholder product imagery (art kit) until sellers upload photos. Fixed-width thumbnail, 3:4. */
export function ItemArt(props: { title: string; seed: string; width: number; label?: string }) {
  return (
    <View style={{ width: props.width, overflow: "hidden", borderRadius: radius.lg }}>
      <ProductArt kind={kindForTitle(props.title)} seed={props.seed} ratio="3:4" {...(props.label !== undefined ? { accessibilityLabel: props.label } : {})} />
    </View>
  );
}
