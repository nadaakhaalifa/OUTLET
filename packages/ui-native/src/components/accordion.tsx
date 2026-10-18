import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { headerState, nextOpenSection, sectionSummary } from "../logic/brand";
import { Icon, PressScale, Text } from "./primitives";

export interface AccordionSection {
  readonly id: string;
  readonly title: string;
  /** e.g. "2 selected"; shown after the title and announced with it. Null/absent = none. */
  readonly summary?: string | null | undefined;
  readonly content: ReactNode;
  readonly testID?: string | undefined;
}

/**
 * Accordion with one section open at a time. Opens without animation (so Reduce Motion is honoured by construction).
 * Header is a 44pt+ button with `expanded` state; chevrons mirror through the kit Icon `directional`.
 */
export function Accordion(props: { sections: readonly AccordionSection[]; initialOpen?: string | null | undefined; onToggle?: ((id: string, open: boolean) => void) | undefined; testID?: string | undefined }) {
  const { colors, s: scale, sc } = useTheme();
  const [open, setOpen] = useState<string | null>(props.initialOpen ?? null);
  return (
    <View testID={props.testID}>
      {props.sections.map((s) => {
        const isOpen = open === s.id;
        return (
          <View key={s.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
            <PressScale
              onPress={() => { const next = nextOpenSection(open, s.id); setOpen(next); props.onToggle?.(s.id, next === s.id); }}
              accessibilityRole="button"
              accessibilityState={headerState(isOpen)}
              accessibilityLabel={sectionSummary(s.title, s.summary ?? null)}
              testID={s.testID}
              scale={1}
            >
              <View style={{ minHeight: sc(48), flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: scale(8), paddingVertical: scale(8) }}>
                <View style={{ flex: 1 }}>
                  <Text variant="headline" weight="500" accessibilityRole="none">{s.title}</Text>
                  {s.summary ? <Text variant="caption" secondary accessibilityRole="none">{s.summary}</Text> : null}
                </View>
                <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={sc(18)} />
              </View>
            </PressScale>
            {isOpen ? <View style={{ paddingBottom: scale(12) }}>{s.content}</View> : null}
          </View>
        );
      })}
    </View>
  );
}
