import { useOptionalServices } from "../../state/services";
import { ClientBannerAnalytics } from "./analytics";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, PanResponder, View, useWindowDimensions } from "react-native";
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withTiming, Easing } from "react-native-reanimated";
import { Image } from "expo-image";
import { devImageSource } from "./dev-images";
import { useFocusEffect, useRouter } from "expo-router";
import { brand, radius } from "@outlet/ui-tokens";
import { LinearGradient } from "expo-linear-gradient";
import { Icon, PressScale, Text, useTheme } from "../../ui";
import { HeroArt } from "../../art";
import { useFormat } from "../home/parts";
import {
  AUTO_ADVANCE_MS, ImpressionOnce, NullBannerAnalytics, dragTarget, goTo, initAuto, pause, resume, routeForCta, selectSlides,
  settleStep, slotX, stepIndex, tick, timerActive, withCount,
  type AutoState, type BannerAnalyticsPort, type HomeBanner, type PauseReason,
} from "./model";

const SLIDE_MS = 700;
/** Board: the hero (under the status area) fills ~43% of the screen height (25% shorter than the first board), including the 24pt sheet overlap. */
const HERO_FRACTION = 0.4275;

const Slide = memo(function Slide(props: { banner: HomeBanner; devFixtures: boolean | undefined; width: number; height: number; position: number; onOpen: (b: HomeBanner, position: number) => void }) {
  const f = useFormat();
  const b = props.banner;
  const lang = f.locale;
  const title = b.title[lang];
  const subtitle = b.subtitle !== null ? b.subtitle[lang] : null;
  const eyebrow = b.sponsored ? f.t("homeBanners.sponsored") : b.eyebrow !== null ? b.eyebrow[lang] : f.t(`homeBanners.kind.${b.cta.kind}`);
  const devSrc = b.imageUrl === null ? devImageSource(b.devImage, props.devFixtures) : null;
  const label = [b.sponsored ? f.t("homeBanners.sponsored") : null, title, subtitle].filter((x): x is string => x !== null).join(", ");
  return (
    <PressScale
      onPress={() => props.onOpen(b, props.position)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={f.t("homeBanners.openHint")}
      testID={`home-banner-${b.id}`}
      scale={1}
      style={{ width: props.width }}
    >
      <View style={{ height: props.height, overflow: "hidden", backgroundColor: brand.ink }}>
        <HeroArt variant={b.art} aspect={props.width / props.height} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
        {b.imageUrl !== null ? (
          <Image source={{ uri: b.imageUrl }} contentFit="cover" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} accessibilityElementsHidden />
        ) : null}
        {/* Readable scrim: transparent at the top, ink at the bottom where the copy sits. */}
        {devSrc !== null ? <Image source={devSrc} contentFit="cover" contentPosition="top" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} accessibilityElementsHidden /> : null}
        <LinearGradient pointerEvents="none" colors={[brand.ink + "59", brand.ink + "00", brand.ink + "00", brand.ink + "B3"]} locations={[0, 0.2, 0.5, 1]} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
        <View style={{ flex: 1, justifyContent: "flex-end", paddingHorizontal: 28, paddingBottom: 58, gap: 6 }}>
          <Text variant="eyebrow" numberOfLines={1} style={{ color: brand.ivory, opacity: 0.9 }} accessibilityRole="none">{eyebrow}</Text>
          <Text variant="hero" numberOfLines={2} maxScale={1.2} style={{ color: brand.ivory, maxWidth: "48%" }} accessibilityRole="none">{title}</Text>
          {subtitle !== null ? <Text variant="body" numberOfLines={1} maxScale={1.3} style={{ color: brand.ivory, opacity: 0.92 }} accessibilityRole="none">{subtitle}</Text> : null}
          <View style={{ alignSelf: "flex-start", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: brand.ivory, marginTop: 2 }}>
            <Text variant="eyebrow" weight="600" style={{ color: brand.ivory }} accessibilityRole="none">{f.t("homeBanners.cta")}</Text>
            <Icon name="arrow-forward" size={16} color="onImage" directional />
          </View>
        </View>
      </View>
    </PressScale>
  );
});

function Bar(props: { active: boolean; reduceMotion: boolean }) {
  const s = useSharedValue(props.active ? 1 : 0);
  useEffect(() => { s.value = withTiming(props.active ? 1 : 0, { duration: props.reduceMotion ? 0 : 280 }); }, [props.active, props.reduceMotion, s]);
  const st = useAnimatedStyle(() => ({ opacity: 0.4 + 0.6 * s.value, width: 14 + 18 * s.value }));
  return <Animated.View style={[{ height: 2, borderRadius: 1, backgroundColor: brand.ivory }, st]} />;
}

export function OffersCarousel(props: { banners: readonly HomeBanner[]; serverNowMs: number; analytics?: BannerAnalyticsPort; topInset?: number; devFixtures?: boolean | undefined }) {
  const f = useFormat();
  const router = useRouter();
  const { isRTL, reduceMotion } = useTheme();
  const win = useWindowDimensions();
  const SLIDE_H = Math.round(win.height * HERO_FRACTION);
  const services = useOptionalServices();
  const tracker = services?.analytics ?? null;
  const analytics = useMemo<BannerAnalyticsPort>(
    () => props.analytics ?? (tracker !== null ? new ClientBannerAnalytics(tracker) : new NullBannerAnalytics()),
    [props.analytics, tracker],
  );
  // Server-anchored "now" at load; the active window is re-evaluated against the elapsed device time.
  const anchor = useRef({ server: props.serverNowMs, device: Date.now() });
  useMemo(() => { anchor.current = { server: props.serverNowMs, device: Date.now() }; }, [props.serverNowMs]);
  const [tickKey, setTickKey] = useState(0);
  const slides = useMemo(
    () => selectSlides(props.banners, anchor.current.server + (Date.now() - anchor.current.device)),
    // tickKey re-runs selection after the carousel advanced past a window boundary.
    [props.banners, props.serverNowMs, tickKey],
  );
  const n = slides.length;

  const [auto, setAuto] = useState<AutoState>(() => initAuto(n));
  const [width, setWidth] = useState(0);
  const drag = useSharedValue(0);
  const busy = useRef(false);
  const impressions = useRef(new ImpressionOnce());
  const autoRef = useRef(auto);
  autoRef.current = auto;

  useEffect(() => { setAuto((s) => withCount(s, n)); }, [n]);
  const setPause = useCallback((r: PauseReason, on: boolean) => setAuto((s) => (on ? pause(s, r) : resume(s, r))), []);
  useEffect(() => { setPause("reduceMotion", reduceMotion); }, [reduceMotion, setPause]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => setPause("background", st !== "active"));
    return () => sub.remove();
  }, [setPause]);
  useFocusEffect(useCallback(() => { setPause("blurred", false); return () => setPause("blurred", true); }, [setPause]));

  const index = n === 0 ? 0 : Math.min(auto.index, n - 1);
  useLayoutEffect(() => { drag.value = 0; busy.current = false; }, [index, drag]);

  // Impression: once per banner, only while the carousel is actually visible (not backgrounded or unfocused).
  const visible = !auto.pauses.includes("background") && !auto.pauses.includes("blurred");
  useEffect(() => {
    const b = slides[index];
    if (b === undefined || !visible) return;
    if (impressions.current.take(b.id)) analytics.impression({ bannerId: b.id, position: index, kind: b.cta.kind, sponsored: b.sponsored });
  }, [slides, index, visible, analytics]);

  const commit = useCallback((step: number) => {
    setAuto((s) => goTo(s, stepIndex(s.index, step, s.count)));
    setTickKey((k) => k + 1);
  }, []);

  const animateStep = useCallback((step: -1 | 0 | 1) => {
    if (width <= 0) return;
    busy.current = step !== 0;
    const target = dragTarget(step, width, isRTL);
    cancelAnimation(drag);
    if (reduceMotion || step === 0) {
      drag.value = withTiming(target, { duration: reduceMotion ? 0 : 200 }, (done) => { if (done && step !== 0) runOnJS(commit)(step); });
    } else {
      drag.value = withTiming(target, { duration: SLIDE_MS, easing: Easing.inOut(Easing.ease) }, (done) => { if (done) runOnJS(commit)(step); });
    }
  }, [width, isRTL, reduceMotion, drag, commit]);

  // The 10 s timer: restarts after every slide change and after any resume.
  const running = timerActive(auto);
  useEffect(() => {
    if (!running || width <= 0) return;
    const id = setTimeout(() => {
      if (!busy.current && timerActive(tick(autoRef.current)) ) animateStep(1);
    }, AUTO_ADVANCE_MS);
    return () => clearTimeout(id);
  }, [running, index, width, animateStep]);

  const widthRef = useRef(width);
  widthRef.current = width;
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { cancelAnimation(drag); setPause("touch", true); },
    onPanResponderMove: (_e, g) => { drag.value = g.dx; },
    onPanResponderRelease: (_e, g) => {
      setPause("touch", false);
      const step = settleStep(g.dx, g.vx, widthRef.current, isRTL, autoRef.current.count);
      animateStep(step);
    },
    onPanResponderTerminate: () => { setPause("touch", false); animateStep(0); },
  }), [drag, isRTL, animateStep, setPause]);

  // Hold the timer while a finger is down on a slide (before a drag is recognised).
  const touchStart = useCallback(() => setPause("touch", true), [setPause]);
  const touchEnd = useCallback(() => setPause("touch", false), [setPause]);

  const open = useCallback((b: HomeBanner, position: number) => {
    analytics.click({ bannerId: b.id, position, kind: b.cta.kind, sponsored: b.sponsored });
    const route = routeForCta(b.cta);
    router.push(route as never);
  }, [analytics, router]);

  const slotStyle = (slot: -1 | 0 | 1) => ({ position: "absolute" as const, top: 0, start: 0, width, transform: [{ translateX: slotX(slot, width, isRTL, 0) }] });
  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value }] }));

  if (n === 0) return null;
  const prevIdx = stepIndex(index, -1, n);
  const nextIdx = stepIndex(index, 1, n);
  const cur = slides[index];
  const prev = slides[prevIdx];
  const next = slides[nextIdx];
  if (cur === undefined || prev === undefined || next === undefined) return null;

  return (
    <View testID="home-offers-carousel" accessibilityLabel={f.t("homeBanners.region")} accessibilityRole="none">
      <View
        style={{ height: SLIDE_H, overflow: "hidden" }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onTouchStart={touchStart}
        onTouchEnd={touchEnd}
        onTouchCancel={touchEnd}
        {...(n > 1 ? responder.panHandlers : {})}
      >
        {width > 0 ? (
          <Animated.View style={[{ height: SLIDE_H, width }, trackStyle]}>
            {n > 1 ? <View style={slotStyle(-1)}><Slide devFixtures={props.devFixtures} banner={prev} width={width} height={SLIDE_H} position={prevIdx} onOpen={open} /></View> : null}
            <View style={slotStyle(0)}><Slide devFixtures={props.devFixtures} banner={cur} width={width} height={SLIDE_H} position={index} onOpen={open} /></View>
            {n > 1 ? <View style={slotStyle(1)}><Slide devFixtures={props.devFixtures} banner={next} width={width} height={SLIDE_H} position={nextIdx} onOpen={open} /></View> : null}
          </Animated.View>
        ) : null}
        {n > 1 ? (
          <View pointerEvents="none" style={{ position: "absolute", start: 28, end: 28, bottom: 36, flexDirection: "row", alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
              {slides.map((s, i) => <Bar key={s.id} active={i === index} reduceMotion={reduceMotion} />)}
            </View>
            <View style={{ position: "absolute", end: 0 }}>
              <Text variant="caption" numeric style={{ color: brand.ivory }} accessibilityRole="none">{f.num(index + 1)}/{f.num(n)}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}
