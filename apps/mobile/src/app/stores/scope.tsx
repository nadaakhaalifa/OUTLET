import { Redirect, useLocalSearchParams } from "expo-router";
import { parseScope } from "../../features/stores-directory/model";

/** Legacy deep link: the scope page was folded into the chooser; forward to the list with the same scope. */
export default function Screen() {
  const { scope } = useLocalSearchParams<{ scope?: string }>();
  return <Redirect href={{ pathname: "/stores/list", params: { scope: parseScope(scope) ?? "both" } }} />;
}
