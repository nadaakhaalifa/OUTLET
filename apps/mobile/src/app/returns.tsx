import { useLocalSearchParams } from "expo-router";
import { ReturnsScreen } from "../features/returns/ReturnsScreen";

export default function Route() {
  const { line } = useLocalSearchParams<{ line?: string }>();
  return <ReturnsScreen orderLineId={typeof line === "string" ? line : ""} />;
}
