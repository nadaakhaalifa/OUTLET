import type { ReactNode } from "react";
import { View } from "react-native";
import { Card, Eyebrow, Text } from "../../ui";

/** Rounded raised card on ivory: small step number, sentence-case title, optional trailing action. */
export function Section(props: { step?: string; title: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <Card variant="elevated" style={{ gap: 16, paddingVertical: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <View style={{ gap: 4, flexShrink: 1 }}>
          {props.step !== undefined ? <Eyebrow secondary>{props.step}</Eyebrow> : null}
          <Text variant="headline" weight="600" accessibilityRole="header">{props.title}</Text>
        </View>
        {props.trailing}
      </View>
      {props.children}
    </Card>
  );
}
