import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * Stable e2e selector (Maestro `id:`) around a control whose design-system component does not yet
 * forward `testID`. Transparent to layout and to accessibility: it adds no label or role.
 */
export function TestId(props: { id: string; children: ReactNode }) {
  return <View testID={props.id}>{props.children}</View>;
}
