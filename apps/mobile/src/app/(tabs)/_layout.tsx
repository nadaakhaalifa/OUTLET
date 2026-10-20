import { Tabs } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabBar, TabBarInsetContext, tabBarInset, useTheme, type IconName, type TabBarItem } from "@outlet/ui-native";
import { TABS, type TabId } from "../../features/navigation/model";
import { getFeaturePorts } from "../../state/ports";
import { pluralKey } from "../../i18n/plural";

const ICONS: Record<TabId, { readonly icon: IconName; readonly active: IconName }> = {
  home: { icon: "home-outline", active: "home" },
  discover: { icon: "compass-outline", active: "compass" },
  saved: { icon: "heart-outline", active: "heart" },
  bag: { icon: "bag-outline", active: "bag" },
  profile: { icon: "person-outline", active: "person" },
};

/** Structural subset of the navigator's tab-bar props (keeps this file free of deep navigation imports). */
interface BarProps {
  readonly state: { readonly index: number; readonly routes: ReadonlyArray<{ readonly key: string; readonly name: string }> };
  readonly navigation: {
    emit(e: { type: "tabPress" | "tabLongPress"; target?: string; canPreventDefault?: boolean }): { readonly type: string; readonly defaultPrevented?: boolean | undefined };
    navigate(name: string): void;
  };
}

/**
 * Home / Discover / Saved / Bag / Profile (ADR-0044). Logical order: the platform mirrors the bar in RTL.
 * A floating glass pill (outline icon + label, filled glyph when active) hovers above the home indicator; scenes
 * pad via TabBarInsetContext. The bag badge is the live unit count of non-saved lines, refreshed on tab changes.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [bagCount, setBagCount] = useState(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => { setTick((n) => n + 1); }, []);
  useEffect(() => {
    let live = true;
    getFeaturePorts().bag.load().then((s) => {
      if (live) setBagCount(s.lines.reduce((n, l) => (l.savedForLater || l.availability !== "available" ? n : n + l.qty), 0));
    }).catch(() => { if (live) setBagCount(0); });
    return () => { live = false; };
  }, [tick]);
  const specByRoute = new Map(TABS.map((x) => [x.route, x] as const));
  return (
    <TabBarInsetContext.Provider value={tabBarInset(insets.bottom)}>
      <Tabs
        screenOptions={{ headerShown: false, animation: "fade", sceneStyle: { backgroundColor: colors.background } }}
        tabBar={(p: BarProps) => {
          const items: TabBarItem[] = [];
          p.state.routes.forEach((route, index) => {
            const spec = specByRoute.get(route.name);
            if (!spec) return;
            const selected = p.state.index === index;
            const count = spec.id === "bag" ? bagCount : 0;
            items.push({
              key: route.key,
              label: t(spec.titleKey),
              icon: ICONS[spec.id].icon,
              activeIcon: ICONS[spec.id].active,
              selected,
              testID: spec.testID,
              badgeCount: count,
              badgeLabel: t(pluralKey("tabsBagCount", count), { n: count }),
              accessibilityLabel: t(spec.titleKey),
              onPress: () => {
                refresh();
                const e = p.navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!selected && e.defaultPrevented !== true) p.navigation.navigate(route.name);
              },
              onLongPress: () => { p.navigation.emit({ type: "tabLongPress", target: route.key }); },
            });
          });
          return <TabBar items={items} />;
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.id} name={tab.route} options={{ title: t(tab.titleKey), tabBarButtonTestID: tab.testID }} />
        ))}
      </Tabs>
    </TabBarInsetContext.Provider>
  );
}
