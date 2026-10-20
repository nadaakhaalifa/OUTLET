import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Image, Pressable, Share, View, useWindowDimensions } from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useRouter } from "expo-router";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { BottomSheet, Button, Divider, ErrorState, Eyebrow, Icon, IconButton, PressScale, Reveal, Screen, Skeleton, Text, useScrollY, useTheme, useToast } from "../../ui";
import { radius } from "@outlet/ui-tokens";
import { ProductArt } from "../../art";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import type { BagPort } from "../bag/model";
import { WISHLIST_INTENTS, type WishlistIntent, type WishlistsPort } from "../wishlists/model";
import { completeTheLook, inferKind, type HomeProduct } from "../home/model";
import { ProductTile, Rail } from "../home/parts";
import { useServices } from "../../state/services";
import { getGuestStore } from "../../state/ports";
import { useGuestGateMode } from "../me/useGuest";
import { LocalSizeProfilePort } from "../size-profile/local";
import { buildPdp, galleryIndex, localFitHint, guestWatchInput, GUEST_WATCH_KIND, gallerySlides, pdpFailureState, type PdpPort, type PdpScreenState } from "./model";
import { getFeaturePorts } from "../../state/ports";
import { AutoBuyEntry } from "../auto-buy/AutoBuyEntry";
import { VisuallySimilarRail } from "../visual-search/VisuallySimilarRail";

type ArtKind = ComponentProps<typeof ProductArt>["kind"];

/** Dev fixtures only (never reached in production: guarded by __DEV__ and the product's devPhoto flag). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DEV_PHOTO: number | null = __DEV__ ? (require("../../../assets/dev-fixtures/board/pdp-photo.png") as number) : null;

function Dot(props: { index: number; x: SharedValue<number>; width: number; color: string }) {
  const st = useAnimatedStyle(() => {
    // Inline math only (worklet rule): closeness of the page position to this dot.
    const d = Math.min(1, Math.abs(props.x.value / props.width - props.index));
    return { transform: [{ scaleX: (6 + 18 * (1 - d)) / 24 }], opacity: 0.4 + 0.6 * (1 - d) };
  });
  return <Animated.View style={[{ height: 3, width: 24, backgroundColor: props.color }, st]} />;
}

function Slide(props: { index: number; x: SharedValue<number>; width: number; kind: ArtKind; seed: string; fill: string }) {
  const st = useAnimatedStyle(() => {
    const off = props.x.value - props.index * props.width;
    return { transform: [{ translateX: off * 0.14 }, { scale: 1.08 }] };
  });
  return (
    <View style={{ width: props.width, aspectRatio: 3 / 4, backgroundColor: props.fill, overflow: "hidden" }}>
      <Animated.View style={[{ flex: 1 }, st]}><ProductArt kind={props.kind} seed={props.seed} ratio="3:4" /></Animated.View>
    </View>
  );
}

/** Paged edge-to-edge gallery: slides drift against the swipe, the page indicator stretches, pull-down zooms. */
function Gallery(props: { slides: number; width: number; kind: ArtKind; seed: string; fill: string; ink: string; pill: string; reduceMotion: boolean; indicatorLabel: (i: number) => string; onIndex: (i: number) => void; index: number }) {
  const x = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { x.value = e.contentOffset.x; });
  const scrollY = useScrollY();
  const h = props.width * (4 / 3);
  const lift = useAnimatedStyle(() => {
    const sy = scrollY !== null && !props.reduceMotion ? scrollY.value : 0;
    const ty = sy < 0 ? sy / 2 : sy * 0.35;
    const sc = sy < 0 ? 1 + Math.min(-sy, h) / h : 1;
    return { transform: [{ translateY: ty }, { scale: sc }] };
  });
  return (
    <View style={{ overflow: "hidden" }}>
      <Animated.View style={lift}>
        <Animated.ScrollView
          horizontal
          pagingEnabled
          bounces={false}
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onMomentumScrollEnd={(e) => {
            // React Native mirrors horizontal scroll offsets itself in RTL, so the raw offset is the page index.
            props.onIndex(galleryIndex(e.nativeEvent.contentOffset.x, props.width, props.slides));
          }}
        >
          {Array.from({ length: props.slides }, (_, i) => (
            <Slide key={i} index={i} x={x} width={props.width} kind={props.kind} seed={`${props.seed}:${i}`} fill={props.fill} />
          ))}
        </Animated.ScrollView>
      </Animated.View>
      {props.slides > 1 ? (
        <View pointerEvents="none" style={{ position: "absolute", bottom: 36, start: 0, end: 0, alignItems: "center" }}>
          <View accessible accessibilityLabel={props.indicatorLabel(props.index)} style={{ paddingHorizontal: 12, minHeight: 24, borderRadius: 12, backgroundColor: props.pill, flexDirection: "row", alignItems: "center", gap: 5 }}>
            {Array.from({ length: props.slides }, (_, i) => <Dot key={i} index={i} x={x} width={props.width} color={props.ink} />)}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Save hint with the selected size's sku when there is one, so Saved can add to bag directly. `skuId` is not in
 * `SaveItemHint` yet (features/wishlists is G5's): it travels as an extra field the guest port can read once added.
 */
function saveHint(title: string, price: bigint, skuId: string | null) {
  return skuId === null ? { title, price } : { title, price, skuId };
}

export function PdpScreen(props: { productId: string; port?: PdpPort; bag?: BagPort; wishlists?: WishlistsPort }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const port = useMemo<PdpPort>(() => props.port ?? getFeaturePorts().pdp, [props.port]);
  const bag = props.bag ?? getFeaturePorts().bag;
  const wishlists = props.wishlists ?? getFeaturePorts().wishlists;
  const [state, setState] = useState<PdpScreenState>({ status: "loading" });
  const [sku, setSku] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);
  const [colorIdx, setColorIdx] = useState(0);
  const { height } = useWindowDimensions();
  const [intentOpen, setIntentOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState<"details" | "delivery" | null>(null);
  const [look, setLook] = useState<readonly HomeProduct[]>([]);
  const guest = useGuestGateMode() === "guest";
  const services = useServices();
  const [watching, setWatching] = useState(false);
  const [usual, setUsual] = useState<string | null>(null);
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", product: await port.load(props.productId) });
    } catch (e) {
      setState(pdpFailureState(e));
    }
  }, [port, props.productId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const r = buildPdp(state.product, null).recommendation;
    if (r === null || !r.sure) return;
    const hit = state.product.sizes.find((z) => z.label === r.sizeLabel && z.stock > 0);
    if (hit !== undefined) setSku((cur) => cur ?? hit.sku);
  }, [state]);

  // Guest: the size profile is read from this phone only; the viewed product is recorded on this phone only.
  useEffect(() => {
    if (!guest) return;
    let alive = true;
    void new LocalSizeProfilePort(services.storage).list().then((p) => { if (alive) setUsual(p[0]?.usualSize ?? null); }, () => undefined);
    return () => { alive = false; };
  }, [guest, services]);
  useEffect(() => {
    if (guest && state.status === "ready") { void getGuestStore().hydrate().then(() => getGuestStore().view(state.product.id)); }
  }, [guest, state]);

  useEffect(() => {
    if (!guest || state.status !== "ready") return;
    const id = state.product.id;
    void getGuestStore().hydrate().then(() => setWatching(getGuestStore().watches().some((a) => a.productId === id && a.kind === GUEST_WATCH_KIND)));
  }, [guest, state]);
  const toggleWatch = (productId: string, skuId: string | null) => {
    const st = getGuestStore();
    if (watching) { st.unwatch(productId, GUEST_WATCH_KIND); setWatching(false); return; }
    if (st.watch(guestWatchInput(productId, skuId)).ok) { setWatching(true); toast.show(t("guestMe.watchTell"), "info"); }
    else toast.show(t("pdp.actionFailed"), "error");
  };

  const title = state.status === "ready" ? state.product.title : "";
  useEffect(() => {
    if (state.status !== "ready") return;
    let alive = true;
    const kind = inferKind(state.product.title);
    void getFeaturePorts().home.load().then((d) => { if (alive) setLook(completeTheLook(state.product.id, kind, d.products)); }, () => undefined);
    return () => { alive = false; };
  }, [state]);

  const run = async (action: () => Promise<void>, ok: string): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      toast.show(ok, "success");
      return true;
    } catch {
      toast.show(t("pdp.actionFailed"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const topBar = (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 4, start: 8, end: 8, flexDirection: "row", justifyContent: "space-between" }}>
      <IconButton variant="plain" color="onImage" icon="arrow-back" directional label={t("pdp.back")} onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} testID="pdp-back" />
      {state.status === "ready" ? (
        <View style={{ flexDirection: "row", gap: 4 }}>
          <IconButton variant="plain" color="onImage" icon={saved ? "heart" : "heart-outline"} label={t("pdp.saveWithIntent")} onPress={() => setIntentOpen(true)} testID="pdp-save" />
          <IconButton variant="plain" color="onImage" icon="bag-handle-outline" label={t("tabs.bag")} onPress={() => router.push("/bag")} testID="pdp-bag" />
        </View>
      ) : null}
    </View>
  );

  if (state.status === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <Screen padded={false} contentStyle={{ paddingTop: 0 }}>
          <View style={{ marginTop: -(insets.top + 12) }}><Skeleton height={width * (4 / 3)} radius={0} /></View>
          <View style={{ padding: 20, gap: 12 }}><Skeleton width="40%" height={12} /><Skeleton width="80%" height={22} /><Skeleton width="30%" height={22} /></View>
        </Screen>
        {topBar}
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={{ flex: 1 }}>
        <Screen>
          <ErrorState offline={state.offline} title={t(state.offline ? "pdp.offlineTitle" : "pdp.errorTitle")} description={t(state.offline ? "pdp.offlineBody" : "pdp.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
        </Screen>
        {topBar}
      </View>
    );
  }

  const p = state.product;
  const v = buildPdp(p, sku);
  const s = p.seller;
  const slides = gallerySlides(p.imageCount);
  const kind = inferKind(p.title);
  const claim = v.price.reference !== null && v.price.discountPct !== null
    ? { referenceMinor: v.price.reference, percent: v.price.discountPct, verified: true, referenceText: money(v.price.reference), percentText: t("home.pctOff", { pct: num(v.price.discountPct) }) }
    : undefined;
  const lowStock = v.sizes.find((z) => z.selected && z.stock.kind === "low") ?? v.sizes.find((z) => z.stock.kind === "low");
  const fitHint = guest ? localFitHint(p.sizes, usual) : null;
  const fitKey = v.communityFit === null ? null : `pdp.fit.${v.communityFit.direction}`;

  const addToBag = async () => {
    if (sku === null) return;
    const size = p.sizes.find((z) => z.sku === sku);
    return run(() => bag.addLine(sku, { storeId: p.seller.storeName, storeName: p.seller.storeName, title: p.title, sizeLabel: size?.label ?? null, unitPrice: p.price }), t("pdp.added"));
  };
  const photoH = Math.round(height * 0.47);
  const photo = p.imageUrl !== null && p.imageUrl !== undefined ? { uri: p.imageUrl } : p.devPhoto === true && DEV_PHOTO !== null ? DEV_PHOTO : null;
  const colorList = p.colors ?? [];
  const hint = v.blocked === "pickSize" ? t("pdp.pickSizeHint") : v.blocked === "paused" ? t("pdp.paused") : v.blocked === "soldOut" ? t("pdp.soldOut") : null;

  return (
    <View style={{ flex: 1 }}>
      <Screen
        padded={false}
        contentStyle={{ paddingTop: 0 }}
      >
        <View style={{ marginTop: -(insets.top + 12) }}>
          <View accessibilityRole="image" accessibilityLabel={t("pdp.galleryName", { title: p.title, count: num(slides) })} accessibilityHint={t("pdp.zoomHint")} style={{ height: photoH + insets.top + 12, overflow: "hidden", backgroundColor: colors.fill }}>
            {photo !== null ? (
              <Image source={photo} resizeMode="cover" style={{ width, height: photoH + insets.top + 12 }} />
            ) : (
              <Gallery
                slides={slides}
                width={width}
                kind={kind}
                seed={p.id}
                fill={colors.fill}
                ink={colors.textPrimary}
                pill={colors.background}
                reduceMotion={reduceMotion}
                index={slide}
                onIndex={setSlide}
                indicatorLabel={(i) => t("pdp.photoIndicator", { index: num(i + 1), count: num(slides) })}
              />
            )}
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 22, paddingBottom: 24, gap: 0, marginTop: -Math.round(height * 0.07), borderTopStartRadius: radius.xxl, borderTopEndRadius: radius.xxl, backgroundColor: colors.background }}>
          <Reveal index={0} style={{ gap: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Eyebrow color="textPrimary">{p.brand ?? s.storeName}</Eyebrow>
                <Text variant="title1" accessibilityRole="header">{p.title}</Text>
              </View>
              {claim !== undefined ? (
                <View style={{ backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, minHeight: 32, minWidth: 54, alignItems: "center", justifyContent: "center" }}>
                  <Text variant="caption" weight="500" style={{ color: colors.onAccent }} accessibilityRole="text">{`-${num(claim.percent)}%`}</Text>
                </View>
              ) : null}
            </View>
            {p.rating !== null && p.rating !== undefined && p.reviewCount !== null && p.reviewCount !== undefined ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                <Icon name="star" size={14} color="textPrimary" />
                <Text variant="callout" weight="500">{localizeDigits(p.rating.toFixed(1), locale)}</Text>
                <Text variant="callout" secondary>{t("pdp.reviews", { count: num(p.reviewCount) })}</Text>
              </View>
            ) : null}
            <View accessible accessibilityLabel={`${money(v.price.price)}${claim !== undefined ? `, ${claim.referenceText}` : ""}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 8 }}>
              <Text variant="quote" weight="600" numeric accessibilityRole="none">{money(v.price.price)}</Text>
              {claim !== undefined ? <Text variant="callout" secondary numeric style={{ textDecorationLine: "line-through" }} accessibilityRole="none">{claim.referenceText}</Text> : null}
            </View>
            {v.price.launchPrice ? <Eyebrow>{t("pdp.launchPrice")}</Eyebrow> : null}
            {v.price.lowestIn30Days ? <Eyebrow color="savings">{t("pdp.lowest30")}</Eyebrow> : null}
          </Reveal>

          {colorList.length > 0 ? (
            <Reveal index={1} style={{ gap: 10, marginTop: 14 }}>
              <Text variant="callout" accessibilityRole="none">{`${t("pdp.colorLabel")}: ${colorList[colorIdx]?.name ?? ""}`}</Text>
              <View style={{ flexDirection: "row", gap: 14 }}>
                {colorList.map((c, i) => (
                  <Pressable key={c.name + i} accessibilityRole="button" accessibilityLabel={c.name} accessibilityState={{ selected: i === colorIdx }} onPress={() => setColorIdx(i)} hitSlop={8}
                    style={{ width: 36, height: 36, borderRadius: radius.lg, borderWidth: i === colorIdx ? 1.5 : 0, borderColor: colors.textPrimary, alignItems: "center", justifyContent: "center" }}>
                    <View style={{ width: 27, height: 27, borderRadius: radius.md, backgroundColor: colors[c.tone] }} />
                  </Pressable>
                ))}
              </View>
            </Reveal>
          ) : null}

          <Reveal index={1} style={{ gap: 8, marginTop: 12 }}>
            <Text variant="callout" accessibilityRole="none">{t("pdp.sizeHeading")}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {v.sizes.map((z) => {
                const on = z.option.sku === sku;
                const out = z.stock.kind === "soldOut";
                return (
                  <Pressable key={z.option.sku} accessibilityRole="button" accessibilityState={{ selected: on, disabled: out }} accessibilityLabel={out ? `${z.option.label}. ${t("pdp.soldOut")}` : z.option.label} disabled={out} onPress={() => setSku(z.option.sku)} hitSlop={2}
                    style={{ flex: 1, height: 36, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.accent : "transparent", borderWidth: on ? 0 : 1, borderColor: colors.hairline, opacity: out ? 0.4 : 1 }}>
                    <Text variant="callout" weight={on ? "500" : "400"} style={{ color: on ? colors.onAccent : colors.textPrimary }} accessibilityRole="none">{z.option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {hint !== null ? <Text variant="caption" secondary>{hint}</Text> : null}
          </Reveal>

          <Reveal index={1} style={{ marginTop: 32 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={t("pdp.addToBagLabel")} accessibilityState={{ disabled: !v.canAddToBag || busy, busy }} disabled={!v.canAddToBag || busy} onPress={() => void addToBag()} testID="pdp-add-to-bag"
              style={{ height: 50, borderRadius: radius.pill, backgroundColor: colors.accent, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, opacity: !v.canAddToBag || busy ? 0.5 : 1 }}>
              <Icon name="bag-handle-outline" size={20} color="onAccent" />
              <Text variant="body" weight="500" style={{ color: colors.onAccent }} accessibilityRole="none">{t("pdp.addToBagLabel")}</Text>
            </Pressable>
          </Reveal>

          <Reveal index={2} style={{ gap: 0, marginTop: 22 }}>
            <Divider />
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: openRow === "details" }} onPress={() => setOpenRow(openRow === "details" ? null : "details")} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text variant="body" accessibilityRole="none">{t("pdp.productDetailsTitle")}</Text>
              <Icon name={openRow === "details" ? "chevron-down" : "chevron-forward"} size={18} color="textPrimary" directional />
            </Pressable>
            {openRow === "details" ? (
              <View style={{ paddingBottom: 16, gap: 4 }}>
                <Text variant="callout">{t("pdp.condition." + p.condition)}</Text>
                {v.price.discountPct !== null ? <Text variant="caption" secondary>{t("pdp.howWeVerify")}</Text> : null}
                <Text variant="caption" secondary>{s.storeName}</Text>
                <Text variant="caption" secondary>{t("pdp.legalName", { name: s.legalName })}</Text>
                <Text variant="caption" secondary>{t("pdp.commercialRegister", { no: s.commercialRegisterNo })}</Text>
                <Text variant="caption" secondary>{t("pdp.taxCard", { no: s.taxCardNo })}</Text>
                <Text variant="caption" secondary>{t("pdp.governorate", { name: s.governorate })}</Text>
                {v.recommendation !== null ? (
                  <Text variant="caption" secondary>
                    {v.recommendation.sure
                      ? t(v.recommendation.inStock ? "pdp.yourSizeShort" : "pdp.yourSizeOut", { size: v.recommendation.sizeLabel, pct: num(v.recommendation.confidencePct) })
                      : t("pdp.notSure")}
                  </Text>
                ) : null}
                {guest && fitHint !== null ? <Text variant="caption" secondary>{t("guestMe.fitFromUsual", { size: fitHint.sizeLabel })}</Text> : null}
                {fitKey !== null && v.communityFit !== null ? <Text variant="caption" secondary>{t(fitKey, { count: num(v.communityFit.sampleCount) })}</Text> : null}
                {v.showDefectNote ? <Text variant="caption" color="danger">{t("pdp.defectNote", { note: p.defectNote ?? "" })}</Text> : null}
              </View>
            ) : null}
            <Divider />
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: openRow === "delivery" }} onPress={() => setOpenRow(openRow === "delivery" ? null : "delivery")} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text variant="body" accessibilityRole="none">{t("pdp.deliveryReturnsTitle")}</Text>
              <Icon name={openRow === "delivery" ? "chevron-down" : "chevron-forward"} size={18} color="textPrimary" directional />
            </Pressable>
            {openRow === "delivery" ? (
              <View style={{ paddingBottom: 16, gap: 8 }}>
                <Text variant="callout">{v.delivery !== null ? t("pdp.delivery", { min: num(v.delivery.min), max: num(v.delivery.max) }) : t("pdp.deliveryUnknown")}</Text>
                <Text variant="callout">
                  {p.returnPolicy.kind === "standard" ? t("pdp.returnsStandard", { days: num(p.returnPolicy.changeOfMindDays), defect: num(p.returnPolicy.defectDays) }) : t("pdp.returnsNone")}
                </Text>
              </View>
            ) : null}
            <Divider />
          </Reveal>
          <View style={{ gap: 8, paddingTop: 8 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Button variant="ghost" title={t("pdp.buyNow")} disabled={!v.canAddToBag || busy} onPress={() => void addToBag().then((ok) => { if (ok === true) router.push(guest ? "/bag" : "/checkout"); })} />
              <Button variant="ghost" title={t("pdp.share")} onPress={() => void Share.share({ message: t("pdp.shareMessage", { title }) }).catch(() => undefined)} />
              {v.offerNotify ? (
                guest
                  ? <Button variant="ghost" title={watching ? t("guestMe.watching") : t("pdp.notifyMe")} accessibilityLabel={watching ? t("guestMe.watchUndo") : t("guestMe.watchTell")} onPress={() => toggleWatch(p.id, sku)} />
                  : <Button variant="ghost" title={t("pdp.notifyMe")} onPress={() => toast.show(t("pdp.notifyOn"), "info")} />
              ) : null}
            </View>
            {guest && v.offerNotify ? <Text variant="caption" secondary>{watching ? t("guestMe.watchNote") : t("guestMe.watchTell")}</Text> : null}
            {lowStock !== undefined && lowStock.stock.kind === "low" ? <Text variant="caption" color="danger">{t("pdp.lowStock", { size: lowStock.option.label, count: num(lowStock.stock.left) })}</Text> : null}
          </View>
          {guest ? null : (
            <AutoBuyEntry
              productId={p.id}
              skuId={sku}
              sizeLabel={p.sizes.find((z) => z.sku === sku)?.label ?? null}
              title={p.title}
              price={v.price.price}
            />
          )}
        </View>

        <View style={{ paddingBottom: 24, paddingTop: 16 }}>
          <VisuallySimilarRail productId={p.id} onOpen={(id) => router.push({ pathname: "/product/[id]", params: { id } })} />
        </View>

        {look.length > 0 ? (
          <View style={{ paddingBottom: 24, paddingTop: 16 }}>
            <Rail itemWidth={172} title={t("pdp.completeLook")}>
              {look.map((x) => <ProductTile key={x.id} product={x} width={172} onOpen={(id) => router.push({ pathname: "/product/[id]", params: { id } })} />)}
            </Rail>
          </View>
        ) : null}
      </Screen>
      {topBar}

      <BottomSheet visible={intentOpen} onClose={() => setIntentOpen(false)} title={t("pdp.intentPicker")} closeLabel={t("pdp.closeIntent")}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {WISHLIST_INTENTS.map((i: WishlistIntent) => (
            <PressScale key={i} accessibilityRole="button" accessibilityLabel={t(`wishlists.intent.${i}`)} onPress={() => { setIntentOpen(false); void run(() => wishlists.saveItem(p.id, i, saveHint(p.title, p.price, sku)), t("pdp.saved")).then((ok) => { if (ok) setSaved(true); }); }}
              innerStyle={{ minHeight: 44, paddingHorizontal: 16, justifyContent: "center", borderRadius: 999, backgroundColor: colors.fill }}>
              <Text variant="callout" accessibilityRole="none">{t(`wishlists.intent.${i}`)}</Text>
            </PressScale>
          ))}
        </View>
      </BottomSheet>
    </View>
  );
}
