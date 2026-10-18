import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { Tabs, useGlobalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabBar, TabBarInsetContext, ThemeProvider, tabBarInset, useTheme, type IconName, type TabBarItem } from "@outlet/ui-native";
import { BrandSessionProvider } from "../../features/brand-mode/kit";
import { BRAND_TABS } from "../../features/brand-mode/tabs";

/** Structural subset of the navigator's tab-bar props (same approach as the shopping tabs). */
interface BarProps {
  readonly state: { readonly index: number; readonly routes: ReadonlyArray<{ readonly key: string; readonly name: string }> };
  readonly navigation: {
    emit(e: { type: "tabPress" | "tabLongPress"; target?: string; canPreventDefault?: boolean }): { readonly type: string; readonly defaultPrevented?: boolean | undefined };
    navigate(name: never): void;
  };
}

const ICONS: Record<string, IconName> = {
  index: "stats-chart-outline",
  products: "shirt-outline",
  orders: "receipt-outline",
  store: "storefront-outline",
};

/** Development-only preview switches (`?theme=dark&lang=ar`) so every state can be reviewed on the simulator. */
function DevPreview(props: { children: ReactNode }) {
  const parent = useTheme();
  const { i18n } = useTranslation();
  const q = useGlobalSearchParams<{ lang?: string; theme?: string }>();
  const dev = typeof __DEV__ !== "undefined" && __DEV__;
  useEffect(() => {
    if (!dev) return;
    if (q.lang === "ar" || q.lang === "en") void i18n.changeLanguage(q.lang);
    if (q.theme === "light" || q.theme === "dark" || q.theme === "system") parent.setPreference(q.theme);
  }, [dev, q.lang, q.theme]);
  if (!dev || (q.lang !== "ar" && q.lang !== "en")) return <>{props.children}</>;
  const rtl = q.lang === "ar";
  return (
    <ThemeProvider preference={parent.preference} onPreferenceChange={parent.setPreference} isRTL={rtl} fontsLoaded={parent.fontsLoaded}>
      <View style={{ flex: 1, direction: rtl ? "rtl" : "ltr" }}>{props.children}</View>
    </ThemeProvider>
  );
}

/** Brand mode: its own flat tab bar (Dashboard / Products / Orders / Store), separate from the shopping tabs. */
export default function BrandTabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const byRoute = new Map<string, (typeof BRAND_TABS)[number]>(BRAND_TABS.map((x) => [x.route, x] as const));
  return (
    <DevPreview>
      <BrandSessionProvider>
        <TabBarInsetContext.Provider value={tabBarInset(insets.bottom)}>
          <Tabs
            screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
            tabBar={(p: BarProps) => {
              const active = p.state.routes[p.state.index];
              if (active !== undefined && !byRoute.has(active.name)) return null;
              const items: TabBarItem[] = [];
              p.state.routes.forEach((route, index) => {
                const spec = byRoute.get(route.name);
                if (!spec) return;
                const selected = p.state.index === index;
                items.push({
                  key: route.key, label: t(spec.titleKey), icon: ICONS[spec.route] ?? "ellipse-outline", selected, testID: spec.testID, accessibilityLabel: t(spec.titleKey),
                  onPress: () => {
                    const e = p.navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                    if (!selected && e.defaultPrevented !== true) p.navigation.navigate(route.name as never);
                  },
                  onLongPress: () => { p.navigation.emit({ type: "tabLongPress", target: route.key }); },
                });
              });
              return <TabBar items={items} />;
            }}
          >
            {BRAND_TABS.map((tab) => <Tabs.Screen key={tab.route} name={tab.route} options={{ title: t(tab.titleKey) }} />)}
            <Tabs.Screen name="product-edit" options={{ href: null }} />
          </Tabs>
        </TabBarInsetContext.Provider>
      </BrandSessionProvider>
    </DevPreview>
  );
}
