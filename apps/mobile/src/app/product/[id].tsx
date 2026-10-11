import { useLocalSearchParams } from "expo-router";
import { PdpScreen } from "../../features/pdp/PdpScreen";

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PdpScreen productId={typeof id === "string" ? id : ""} />;
}
