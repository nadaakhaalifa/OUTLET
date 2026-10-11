import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { minTouchTarget, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, Text } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { pickText, uuidv7 } from "../checkout/model";
import {
  applyCancelled, canCancel, formatDay, ordersFailureState, progress, resumable, returnable, safeReceiptUrl,
  sortOrders, trackingTimeline, type OrderGroup, type OrdersPort, type OrdersScreenState, type SellerOrder,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

function newKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

export interface OrdersScreenProps {
  readonly port?: OrdersPort;
  readonly onResumePayment?: (orderGroupId: string) => void;
  readonly onReturnLine?: (orderLineId: string) => void;
}

function SellerOrderCard(props: {
  o: SellerOrder; lang: "ar" | "en"; locale: DisplayLocale; money: (m: bigint) => string;
  onCancel: (id: string) => void; busy: boolean; onReturnLine?: ((id: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { o, lang, locale } = props;
  const day = (iso: string) => formatDay(iso, (s) => localizeDigits(s, locale));
  const statusText = t(`orders.status.${o.status}`);
  const p = progress(o.status);
  const url = safeReceiptUrl(o.eReceipt);
  return (
    <Card>
      <Text variant="heading">{t("orders.sellerHeading", { store: o.storeName })}</Text>
      <Text>{statusText}</Text>
      {p.onPath ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("orders.progressName", { status: statusText })} style={{ gap: spacing.xs }}>
          {p.steps.map((s) => (
            <View key={s.step} accessible accessibilityLabel={t(s.current ? "orders.stepCurrent" : s.done ? "orders.stepDone" : "orders.stepPending", { step: t(`orders.status.${s.step}`) })}>
              <Text variant="caption" secondary>{`${s.done ? "●" : "○"} ${t(`orders.status.${s.step}`)}`}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {o.lines.map((l) => (
        <Text key={l.id} variant="caption" secondary>{t("orders.itemLine", { title: l.title, qty: localizeDigits(String(l.qty), locale), amount: props.money(l.unitPrice * BigInt(l.qty)) })}</Text>
      ))}
      <Text>{t("orders.total", { amount: props.money(o.total) })}</Text>
      <Divider />
      <Text variant="caption" secondary>{t("orders.trackingHeading")}</Text>
      {o.shipment === null ? <Text secondary>{t("orders.noTracking")}</Text> : (
        <View style={{ gap: spacing.xs }}>
          <Text>{t("orders.courier", { courier: o.shipment.courier, awb: o.shipment.awb })}</Text>
          {o.shipment.etaAt !== null ? <Text secondary>{t("orders.eta", { date: day(o.shipment.etaAt) })}</Text> : null}
          {trackingTimeline(o.shipment).map((e) => (
            <Text key={`${e.status}-${e.at}`} variant="caption" secondary>{`${day(e.at)}: ${pickText(e.label, lang)}`}</Text>
          ))}
        </View>
      )}
      {canCancel(o.status) ? (
        <Button variant="destructive" disabled={props.busy} title={t("orders.cancel")} accessibilityLabel={t("orders.cancelName", { store: o.storeName })} onPress={() => props.onCancel(o.id)} />
      ) : o.status === "SHIPPED" || o.status === "OUT_FOR_DELIVERY" ? (
        <Text variant="caption" secondary>{t("orders.cannotCancel")}</Text>
      ) : null}
      {o.eReceipt !== null ? <Text variant="caption" secondary>{t("orders.receiptId", { uuid: o.eReceipt.uuid })}</Text> : null}
      {url !== null ? (
        <Button variant="secondary" title={t("orders.receiptOpen")} accessibilityLabel={t("orders.receiptName", { store: o.storeName })} onPress={() => void Linking.openURL(url)} />
      ) : (
        <Text variant="caption" secondary>{t("orders.receiptPending")}</Text>
      )}
      {returnable(o) && props.onReturnLine !== undefined
        ? o.lines.map((l) => (
            <Button key={l.id} variant="secondary" title={t("orders.returnItem")} accessibilityLabel={t("orders.returnItemName", { title: l.title })} onPress={() => props.onReturnLine?.(l.id)} />
          ))
        : null}
    </Card>
  );
}

export function OrdersScreen(props: OrdersScreenProps) {
  const { t, i18n } = useTranslation();
  const lang: "ar" | "en" = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<OrdersPort>(() => props.port ?? getFeaturePorts().orders, [props.port]);
  const currency = t("common.currency");
  const money = useCallback((m: bigint) => formatMoney(m, locale, currency), [locale, currency]);
  const [state, setState] = useState<OrdersScreenState>({ status: "loading" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", groups: sortOrders(await port.list()) });
    } catch (e) {
      setState(ordersFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const cancel = async (sellerOrderId: string) => {
    if (busy || state.status !== "ready") return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await port.cancel(sellerOrderId, newKey());
      if (r.ok) {
        setState({ status: "ready", groups: applyCancelled(state.groups, sellerOrderId) });
        setMessage({ tone: "info", text: t("orders.cancelled") });
      } else setMessage({ tone: "error", text: t("orders.cancelFailed") });
    } catch {
      setMessage({ tone: "error", text: t("orders.cancelFailed") });
    } finally {
      setBusy(false);
    }
  };

  const groups: readonly OrderGroup[] = state.status === "ready" ? state.groups : [];
  const open = groups.find((g) => g.id === openId) ?? null;
  const placed = (g: OrderGroup) => formatDay(g.placedAt, (s) => localizeDigits(s, locale));

  return (
    <Screen>
      <Text variant="title">{t("orders.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("orders.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState offline={state.offline} title={t(state.offline ? "orders.offlineTitle" : "orders.errorTitle")}
          description={t(state.offline ? "orders.offlineBody" : "orders.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
      ) : null}
      {state.status === "ready" && groups.length === 0 ? <EmptyState title={t("orders.emptyTitle")} description={t("orders.emptyBody")} /> : null}
      {message !== null ? <Banner tone={message.tone} message={message.text} /> : null}
      {open === null
        ? groups.map((g) => (
            <Card key={g.id}>
              <Pressable testID={`order-row-${g.id}`} accessibilityRole="button" accessibilityLabel={t("orders.openOrder", { id: g.id })} onPress={() => setOpenId(g.id)}
                style={{ minHeight: minTouchTarget, justifyContent: "center", gap: spacing.xs }}>
                <Text variant="heading">{t("orders.placedOn", { date: placed(g) })}</Text>
                <Text secondary>{t("orders.total", { amount: money(g.total) })}</Text>
                <Text variant="caption" secondary>{t(`orders.status.${g.state === "pending_payment" ? "PENDING_PAYMENT" : g.state === "confirmed_cod" ? "CONFIRMED_COD" : g.state === "paid" ? "PAID" : "CANCELLED"}`)}</Text>
              </Pressable>
              {resumable(g) ? (
                <>
                  <Banner tone="warning" message={t("orders.pendingPayment")} />
                  {props.onResumePayment !== undefined ? <Button title={t("orders.resume")} onPress={() => props.onResumePayment?.(g.id)} /> : null}
                </>
              ) : null}
            </Card>
          ))
        : (
          <>
            <Button variant="secondary" title={t("orders.back")} onPress={() => setOpenId(null)} />
            <Text variant="heading">{t("orders.placedOn", { date: placed(open) })}</Text>
            {open.sellerOrders.map((o) => (
              <SellerOrderCard key={o.id} o={o} lang={lang} locale={locale} money={money} busy={busy} onCancel={(id) => void cancel(id)} onReturnLine={props.onReturnLine} />
            ))}
          </>
        )}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
