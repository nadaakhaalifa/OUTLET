import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { useColors } from "../../theme";

/** Phase 1 tabs. The Stylist tab arrives with the stylist in Phase 2 (spec §P3). */
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
      }}
    >
      <Tabs.Screen name="index" options={{ title: t("tabs.home") }} />
      <Tabs.Screen name="explore" options={{ title: t("tabs.explore") }} />
      <Tabs.Screen name="bag" options={{ title: t("tabs.bag") }} />
      <Tabs.Screen name="me" options={{ title: t("tabs.me") }} />
    </Tabs>
  );
}
