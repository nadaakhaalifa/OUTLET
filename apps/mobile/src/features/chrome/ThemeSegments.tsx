import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { minTouchTarget, radius } from "@outlet/ui-tokens";
import { Icon, useTheme } from "../../ui";
import { THEME_SEGMENTS, themeSegmentIcon, type ThemeSegment } from "./model";

/**
 * Sun and moon segments in one pill, icons only. Tap the one you want. The active segment is filled with brand and onBrand.
 * A fresh install stores "system": the segment matching the CURRENT effective appearance (theme.isDark) shows active.
 * Tapping sets an explicit light or dark; there is deliberately no way back to "system" from this control.
 */
export function ThemeSegments(props: { testIDPrefix: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { colors, s, spacing } = theme;
  const effective: ThemeSegment = theme.isDark ? "dark" : "light";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t("chrome.themeGroup")}
      style={{ flexDirection: "row", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.hairline, padding: spacing.xs / 2, backgroundColor: colors.sand }}
    >
      {THEME_SEGMENTS.map((p) => {
        const active = effective === p;
        return (
          <Pressable
            key={p}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, checked: active }}
            accessibilityLabel={t(`chrome.theme.${p}`)}
            onPress={() => theme.setPreference(p)}
            testID={`${props.testIDPrefix}-theme-${p}`}
            hitSlop={0}
            style={{
              minHeight: s(minTouchTarget), minWidth: s(minTouchTarget), flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.pill, backgroundColor: active ? colors.brand : "transparent",
            }}
          >
            <Icon name={themeSegmentIcon(p)} color={active ? "onBrand" : "textPrimary"} />
          </Pressable>
        );
      })}
    </View>
  );
}
