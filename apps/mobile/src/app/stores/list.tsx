import { useLocalSearchParams } from "expo-router";
import { StoresScreen } from "../../features/stores-directory/StoresScreen";
import { parseScope } from "../../features/stores-directory/model";

export default function Screen() {
  const { scope } = useLocalSearchParams<{ scope?: string }>();
  return <StoresScreen scope={parseScope(scope) ?? "both"} />;
}
