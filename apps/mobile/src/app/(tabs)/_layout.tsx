import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { TABS } from "../../features/navigation/model";
import { useColors } from "../../theme";

/**
 * Home / Explore / Stylist / Bag / Me (spec Part C). Order is logical: the platform mirrors the bar
 * in RTL, so no manual reversal. Selected state comes from the navigator's tab buttons.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textSecondary,
        tabBarStyle: { backgroundColor: c.background, borderTopColor: c.border },
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.id}
          name={tab.route}
          options={{ title: t(tab.titleKey), tabBarAccessibilityLabel: t(tab.titleKey), tabBarButtonTestID: tab.testID }}
        />
      ))}
    </Tabs>
  );
}
