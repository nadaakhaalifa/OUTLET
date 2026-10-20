import { AccessibilityInfo, Pressable, View, type AccessibilityActionEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { controlSize, minTouchTarget, radius } from "@outlet/ui-tokens";
import { selectionTick, useTheme } from "../../ui";
import { cycleDensity, maxDensityForFontScale, stepDenser, stepSparser, type Density } from "./model";

const GLYPH = 18;
const GLYPH_GAP = 2;

/** n x n squares for the current density. Symmetric, so it is the same in RTL. */
function DensityGlyph(props: { density: Density }) {
  const { colors } = useTheme();
  const n = props.density;
  const cell = (GLYPH - GLYPH_GAP * (n - 1)) / n;
  const rows = Array.from({ length: n }, (_, r) => r);
  return (
    <View style={{ width: GLYPH, height: GLYPH, gap: GLYPH_GAP }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {rows.map((r) => (
        <View key={r} style={{ flexDirection: "row", gap: GLYPH_GAP }}>
          {rows.map((c) => (
            <View key={c} style={{ width: cell, height: cell, borderRadius: radius.xs / 2, backgroundColor: colors.textPrimary }} />
          ))}
        </View>
      ))}
    </View>
  );
}

export interface GridDensityToggleProps {
  density: Density;
  onChange: (next: Density) => void;
  testID?: string | undefined;
}

/** Visible alternative to pinch (WCAG 2.5.1). Tap cycles 2 -> 3 -> 4 -> 1; VoiceOver swipe up/down steps. */
export function GridDensityToggle(props: GridDensityToggleProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { fontScale, sizeClass } = useTheme().layout;
  const max = maxDensityForFontScale(fontScale, sizeClass !== "compact");
  const valueText = props.density === 1 ? t("gridDensity.perRowOne") : t("gridDensity.perRow", { count: props.density });

  const change = (next: Density) => {
    if (next === props.density) return;
    selectionTick();
    props.onChange(next);
    const msg = next === 1 ? t("gridDensity.announceOne") : t("gridDensity.announce", { count: next });
    // Cells remount on relayout; announce so the new state is not silent.
    AccessibilityInfo.announceForAccessibility(msg);
  };

  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") change(stepDenser(props.density, max));
    else if (e.nativeEvent.actionName === "decrement") change(stepSparser(props.density));
  };

  const slop = Math.max(0, (minTouchTarget - controlSize.iconDisc) / 2);
  return (
    <Pressable
      testID={props.testID ?? "grid-density-toggle"}
      accessibilityRole="adjustable"
      accessibilityLabel={t("gridDensity.toggleLabel")}
      accessibilityValue={{ text: valueText }}
      accessibilityHint={t("gridDensity.hint")}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAction}
      onPress={() => change(cycleDensity(props.density, max))}
      hitSlop={slop}
      style={{ width: controlSize.iconDisc, height: controlSize.iconDisc, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.fill }}
    >
      <DensityGlyph density={props.density} />
    </Pressable>
  );
}
