import { devDeptImage } from "../home-banners/dev-images";
import { memo, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { brand, radius } from "@outlet/ui-tokens";
import { Icon, PressScale, Skeleton, Text, useTheme } from "../../ui";
import { HeroArt } from "../../art";
import { Ticker } from "../../components/Ticker";
import { DropClock } from "./banner";
import {
  DEPARTMENTS, DEPARTMENT_ART, HOME_CARD_RADIUS, DEPARTMENT_TONE, dropBanner, dropIndicator, dropPageIndex, type Department, type HeroDrop,
} from "./model";
import { useFormat } from "./parts";

const STRIP_H = 76;

/** Integrated strip on the page background: thumbnail, tracked eyebrow, title and store, chevron; hairlines only. */
function DropCard(props: { drop: HeroDrop; width: number; nowFn: () => number; onOpen: (id: string) => void }) {
  const f = useFormat();
  const { colors } = useTheme();
  const d = props.drop;
  return (
    <Ticker nowFn={props.nowFn} render={(nowMs) => {
      const b = dropBanner(d, nowMs);
      if (b === null) return null;
      const status = f.t(b.live ? "shopAll.bannerLive" : "shopAll.bannerUpcoming");
      const label = f.t("home.dropCardA11y", { title: b.title, status }) + (b.storeName.length > 0 ? `, ${b.storeName}` : "");
      return (
        <PressScale onPress={() => props.onOpen(d.id)} accessibilityRole="button" accessibilityLabel={label} testID={`home-drop-${d.id}`} scale={0.99} style={{ width: props.width }}>
          <View style={{ minHeight: STRIP_H, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.hairline }}>
            <View style={{ width: 52, height: 52, borderRadius: HOME_CARD_RADIUS, overflow: "hidden" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <HeroArt variant={b.variant} aspect={1} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="eyebrow" {...(b.live ? { color: "savings" as const } : { secondary: true })} accessibilityRole="none">{status}</Text>
              <Text variant="callout" weight="600" numberOfLines={1} accessibilityRole="none">{b.title}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8 }}>
                <Text variant="caption" secondary numberOfLines={1} style={{ flexShrink: 1 }} accessibilityRole="none">{b.storeName}</Text>
                {b.countdown !== null ? <DropClock c={b.countdown} /> : null}
              </View>
            </View>
            <Icon name="chevron-forward" size={18} color="textSecondary" directional />
          </View>
        </PressScale>
      );
    }} />
  );
}

/** Manual paging strip of real upcoming or live drops, page dots below. No auto-advance; the only timers are the countdown leaves. */
export function DropsCarousel(props: { drops: readonly HeroDrop[]; nowFn: () => number; onOpen: (id: string) => void }) {
  const f = useFormat();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const n = props.drops.length;
  if (n === 0) return null;
  const ind = dropIndicator(index, n);
  return (
    <View style={{ gap: 8 }} accessibilityLabel={f.t("home.dropsRegion")} testID="home-drops">
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={32}
        onMomentumScrollEnd={(e) => setIndex(dropPageIndex(Math.abs(e.nativeEvent.contentOffset.x), width, n, 0))}
      >
        {props.drops.map((d) => <DropCard key={d.id} drop={d} width={width} nowFn={props.nowFn} onOpen={props.onOpen} />)}
      </ScrollView>
      {ind !== null ? (
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }} testID="home-drops-indicator" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {props.drops.map((d, i) => (
            <View key={d.id} style={{ width: i === ind.current - 1 ? 16 : 6, height: 6, borderRadius: radius.pill, backgroundColor: i === ind.current - 1 ? colors.accent : colors.fieldBorder }} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function DropsSkeleton() {
  return <View style={{ paddingHorizontal: 16 }}><Skeleton height={STRIP_H - 20} radius={HOME_CARD_RADIUS} /></View>;
}

/** Image-led department row: tall art cards, serif label over a bottom scrim. Scrolls so large text never clips. */
export const DepartmentGrid = memo(function DepartmentGrid(props: { onOpen: (d: Department) => void; images?: Partial<Record<Department, string>> | undefined; devFixtures?: boolean | undefined }) {
  const f = useFormat();
  return (
    <View
      accessibilityLabel={f.t("home.deptRegion")}
      testID="home-departments"
      style={{ flexDirection: "row", gap: 12, paddingHorizontal: 16 }}
    >
      {DEPARTMENTS.map((d) => {
        const devSrc = props.images?.[d] === undefined ? devDeptImage(d, props.devFixtures) : null;
        const name = f.t(devSrc !== null && d === "accessories" ? "home.dept.lifestyle" : `home.dept.${d}`);
        const uri = props.images?.[d];
        return (
          <PressScale key={d} onPress={() => props.onOpen(d)} accessibilityRole="button" accessibilityLabel={f.t("home.deptA11y", { name })} testID={`home-dept-${d}`} scale={0.97} style={{ flex: 1 }}>
            <View style={{ height: 92, borderRadius: HOME_CARD_RADIUS, overflow: "hidden", backgroundColor: DEPARTMENT_TONE[d], justifyContent: "flex-end" }}>
              <View style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, opacity: 0.55 }}>
                <HeroArt variant={DEPARTMENT_ART[d]} aspect={0.6} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
              </View>
              {/* Real photo slot: shows the moment a URL exists; art is the fallback. */}
              {devSrc !== null ? <Image source={devSrc} contentFit="cover" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} accessibilityElementsHidden /> : null}
              {uri !== undefined ? <Image source={{ uri }} contentFit="cover" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} accessibilityElementsHidden /> : null}
              {/* Soft bottom scrim (transparent to 0.35 ink), no box; keeps ivory text legible. */}
              <LinearGradient
                colors={[brand.ink + "00", brand.ink + "59"]}
                style={{ position: "absolute", start: 0, end: 0, bottom: 0, height: 52 }}
                pointerEvents="none"
              />
              <View style={{ paddingHorizontal: 12, paddingBottom: 12, alignItems: "flex-start" }}>
                <Text variant="tile" numberOfLines={1} maxScale={1.2} style={{ color: brand.ivory, textShadowColor: brand.ink + "40", textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } }} accessibilityRole="none">{name}</Text>
              </View>
            </View>
          </PressScale>
        );
      })}
    </View>
  );
});
