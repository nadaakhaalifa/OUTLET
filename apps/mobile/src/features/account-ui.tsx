/** Shared account-screen layout pieces: unboxed hairline sections instead of cards. */
import type { ReactNode } from "react";
import { View } from "react-native";
import { Divider, Reveal, Text } from "../ui";

/** A titled group: hairline above, serif section head, then content. No fill, no border box. Staggers in. */
export function Section(props: { title?: string; children: ReactNode; gap?: number; index?: number }) {
  return (
    <Reveal index={props.index ?? 1}>
      <View style={{ gap: props.gap ?? 16, paddingTop: 8 }}>
        <Divider />
        {props.title !== undefined ? <Text variant="title1" accessibilityRole="header">{props.title}</Text> : null}
        {props.children}
      </View>
    </Reveal>
  );
}

/** Two-column label / value line used in lists (balances, summaries). */
export function KeyLine(props: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>{props.children}</View>;
}

/** Hairline + serif head for flat (non-Section) layouts; staggers in. `first` drops the hairline. */
export function SectionHead(props: { title: string; index?: number; first?: boolean }) {
  return (
    <Reveal index={props.index ?? 1}>
      <View style={{ gap: 14, paddingTop: props.first === true ? 0 : 12 }}>
        {props.first === true ? null : <Divider />}
        <Text variant="title1" accessibilityRole="header">{props.title}</Text>
      </View>
    </Reveal>
  );
}
