import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Badge, Banner, Button, Card, Divider, ErrorState, LoadingState, Screen, Text } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { opt } from "../search/optional";
import { Chip } from "../search/Chip";
import type { BagPort } from "../bag/model";
import { WISHLIST_INTENTS, type WishlistIntent, type WishlistsPort } from "../wishlists/model";
import { buildPdp, pdpFailureState, type PdpPort, type PdpScreenState } from "./model";
import { getFeaturePorts } from "../../state/ports";

export function PdpScreen(props: { productId: string; port?: PdpPort; bag?: BagPort; wishlists?: WishlistsPort }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<PdpPort>(() => props.port ?? getFeaturePorts().pdp, [props.port]);
  const bag = props.bag ?? getFeaturePorts().bag;
  const wishlists = props.wishlists ?? getFeaturePorts().wishlists;
  const [state, setState] = useState<PdpScreenState>({ status: "loading" });
  const [sku, setSku] = useState<string | null>(null);
  const [intentOpen, setIntentOpen] = useState(false);
  const [notice, setNotice] = useState<"added" | "saved" | "failed" | "notify" | null>(null);
  const [busy, setBusy] = useState(false);
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

  const run = async (action: () => Promise<void>, ok: "added" | "saved") => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(ok);
    } catch {
      setNotice("failed");
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <Screen><LoadingState label={t("pdp.loading")} /></Screen>;
  if (state.status === "error") {
    return (
      <Screen>
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "pdp.offlineTitle" : "pdp.errorTitle")}
          description={t(state.offline ? "pdp.offlineBody" : "pdp.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      </Screen>
    );
  }

  const p = state.product;
  const v = buildPdp(p, sku);
  const s = p.seller;
  const fitKey = v.communityFit === null ? null : `pdp.fit.${v.communityFit.direction}`;
  return (
    <Screen>
      <View accessibilityRole="image" accessibilityLabel={t("pdp.galleryName", { title: p.title, count: num(p.imageCount) })} style={{ minHeight: 240, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" }}>
        <Text secondary>{t("pdp.galleryPlaceholder")}</Text>
      </View>
      <Text variant="title">{p.title}</Text>

      <Card>
        <Text variant="caption" secondary>{t("pdp.soldBy")}</Text>
        <Text variant="heading">{s.storeName}</Text>
        <Text variant="caption" secondary>{t("pdp.legalName", { name: s.legalName })}</Text>
        <Text variant="caption" secondary>{t("pdp.commercialRegister", { no: s.commercialRegisterNo })}</Text>
        <Text variant="caption" secondary>{t("pdp.taxCard", { no: s.taxCardNo })}</Text>
        <Text variant="caption" secondary>{t("pdp.governorate", { name: s.governorate })}</Text>
      </Card>

      <Card>
        <Text variant="heading" accessibilityRole="text">{money(v.price.price)}</Text>
        {v.price.reference !== null && v.price.discountPct !== null ? (
          <>
            <Text secondary style={{ textDecorationLine: "line-through" }}>{t("pdp.reference", { amount: money(v.price.reference) })}</Text>
            <Badge tone="info" label={t("pdp.verifiedDiscount", { pct: num(v.price.discountPct) })} />
          </>
        ) : null}
        {v.price.lowestIn30Days ? <Badge tone="info" label={t("pdp.lowest30")} /> : null}
        {v.price.launchPrice ? <Badge tone="info" label={t("pdp.launchPrice")} /> : null}
        {v.price.discountPct !== null ? <Text variant="caption" secondary>{t("pdp.howWeVerify")}</Text> : null}
      </Card>

      <Text variant="heading">{t("pdp.sizeHeading")}</Text>
      {v.recommendation !== null ? (
        <Banner
          tone={v.recommendation.sure ? "info" : "warning"}
          prefix={t("pdp.recommendationPrefix")}
          message={
            v.recommendation.sure
              ? t(v.recommendation.inStock ? "pdp.yourSize" : "pdp.yourSizeOut", { size: v.recommendation.sizeLabel, pct: num(v.recommendation.confidencePct) })
              : t("pdp.notSure")
          }
        />
      ) : <Text secondary>{t("pdp.noRecommendation")}</Text>}
      <View accessibilityRole="radiogroup" accessibilityLabel={t("pdp.sizePicker")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {v.sizes.map((z) => (
          <Chip
            key={z.option.sku}
            role="radio"
            label={z.option.label}
            accessibilityLabel={z.stock.kind === "soldOut" ? t("pdp.sizeSoldOutName", { size: z.option.label }) : z.stock.kind === "low" ? t("pdp.sizeLowName", { size: z.option.label, count: num(z.stock.left) }) : t("pdp.sizeName", { size: z.option.label })}
            selected={z.selected}
            disabled={z.stock.kind === "soldOut"}
            onPress={() => setSku(z.option.sku)}
          />
        ))}
      </View>
      {v.sizes.filter((z) => z.stock.kind === "low").map((z) => (
        <Text key={z.option.sku} variant="caption" secondary>{t("pdp.lowStock", { size: z.option.label, count: num(z.stock.kind === "low" ? z.stock.left : 0) })}</Text>
      ))}
      {fitKey !== null && v.communityFit !== null ? <Text secondary>{t(fitKey, { count: num(v.communityFit.sampleCount) })}</Text> : null}

      <Divider />
      <Text secondary>{t("pdp.condition." + p.condition)}</Text>
      {v.showDefectNote ? <Banner tone="warning" message={t("pdp.defectNote", { note: p.defectNote ?? "" })} /> : null}
      <Text>{v.delivery !== null ? t("pdp.delivery", { min: num(v.delivery.min), max: num(v.delivery.max) }) : t("pdp.deliveryUnknown")}</Text>
      <Text secondary>
        {p.returnPolicy.kind === "standard"
          ? t("pdp.returnsStandard", { days: num(p.returnPolicy.changeOfMindDays), defect: num(p.returnPolicy.defectDays) })
          : t("pdp.returnsNone")}
      </Text>

      {v.blocked === "paused" ? <Banner tone="warning" message={t("pdp.paused")} /> : null}
      {v.blocked === "soldOut" ? <Banner tone="warning" message={t("pdp.soldOut")} /> : null}
      {notice === "added" ? <Banner tone="info" message={t("pdp.added")} /> : null}
      {notice === "saved" ? <Banner tone="info" message={t("pdp.saved")} /> : null}
      {notice === "notify" ? <Banner tone="info" message={t("pdp.notifyOn")} /> : null}
      {notice === "failed" ? <Banner tone="error" message={t("pdp.actionFailed")} /> : null}

      <Button
        title={t("pdp.addToBag")}
        disabled={!v.canAddToBag || busy}
        loading={busy}
        {...opt("accessibilityHint", v.blocked === "pickSize" ? t("pdp.pickSizeHint") : undefined)}
        onPress={() => {
          if (sku === null) return;
          const size = p.sizes.find((z) => z.sku === sku);
          void run(() => bag.addLine(sku, { storeId: p.seller.storeName, storeName: p.seller.storeName, title: p.title, sizeLabel: size?.label ?? null, unitPrice: p.price }), "added");
        }}
      />
      {v.blocked === "pickSize" ? <Text variant="caption" secondary>{t("pdp.pickSizeHint")}</Text> : null}
      {v.offerNotify ? <Button variant="secondary" title={t("pdp.notifyMe")} onPress={() => setNotice("notify")} /> : null}
      <Button variant="secondary" title={t("pdp.saveWithIntent")} onPress={() => setIntentOpen((o) => !o)} />
      {intentOpen ? (
        <View accessibilityLabel={t("pdp.intentPicker")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {WISHLIST_INTENTS.map((i: WishlistIntent) => (
            <Chip key={i} label={t(`wishlists.intent.${i}`)} selected={false} onPress={() => { setIntentOpen(false); void run(() => wishlists.saveItem(p.id, i, { title: p.title, price: p.price }), "saved"); }} />
          ))}
        </View>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
