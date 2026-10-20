import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import { minTouchTarget, spacing } from "@outlet/ui-tokens";
import {
  Badge, Banner, BottomSheet, Button, Card, Chip, EmptyState, ErrorState, Icon, LoadingState, PressScale, Screen, Text, useTheme,
} from "../../ui";
import { Illustration } from "../../art";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { orderNumber, pickText, uuidv7 } from "../checkout/model";
import { ItemArt } from "../purchase/ItemArt";
import { TextAction } from "../purchase/TextAction";
import { Flow } from "../purchase/motion";
import {
  applyCancelled, canCancel, filterOrders, formatDay, groupStatusKey, ordersFailureState, progress, resumable, returnable, safeReceiptUrl,
  sortOrders, trackingTimeline, type OrderFilter, type OrderGroup, type OrdersPort, type OrdersScreenState, type SellerOrder, type SellerOrderStatus,
} from "./model";
import { getFeaturePorts } from "../../state/ports";
import { pluralKey } from "../../i18n/plural";

function newKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

export interface OrdersScreenProps {
  readonly port?: OrdersPort;
  readonly onResumePayment?: (orderGroupId: string) => void;
  readonly onReturnLine?: (orderLineId: string) => void;
  readonly onShop?: () => void;
  /** Back from the list (Me and the checkout success both lead here). */
  readonly onBack?: () => void;
}

const FILTERS: readonly OrderFilter[] = ["all", "active", "delivered", "closed"];

function statusKind(s: SellerOrderStatus): "verified" | "neutral" {
  return s === "DELIVERED" || s === "CLOSED" ? "verified" : "neutral";
}

/** Vertical timeline: ink dot for done, hollow for pending, hairline rail. */
function Timeline(props: { items: readonly { key: string; label: string; meta?: string; done: boolean; current?: boolean }[] }) {
  const { colors } = useTheme();
  return (
    <View>
      {props.items.map((it, i) => (
        <Flow key={it.key} index={i} style={{ flexDirection: "row", gap: spacing.md, minHeight: 40 }}>
         <View accessible accessibilityLabel={`${it.label}${it.meta !== undefined ? `, ${it.meta}` : ""}`} style={{ flexDirection: "row", gap: spacing.md, flex: 1 }}>
          <View style={{ alignItems: "center", width: 14 }}>
            <View style={{ width: 10, height: 10, marginTop: 5, borderRadius: 5, borderWidth: 1, borderColor: it.done ? colors.accent : colors.textSecondary, backgroundColor: it.done ? colors.accent : "transparent" }} />
            {i < props.items.length - 1 ? <View style={{ flex: 1, width: 1, backgroundColor: colors.hairline }} /> : null}
          </View>
          <View style={{ flex: 1, paddingBottom: spacing.md }}>
            <Text variant="callout" weight={it.current === true ? "500" : "400"} secondary={!it.done}>{it.label}</Text>
            {it.meta !== undefined ? <Text variant="caption" secondary>{it.meta}</Text> : null}
          </View>
         </View>
        </Flow>
      ))}
    </View>
  );
}

function SellerOrderBlock(props: {
  o: SellerOrder; lang: "ar" | "en"; locale: DisplayLocale; money: (m: bigint) => string;
  onCancel: (id: string) => void; busy: boolean; onReturnLine?: ((id: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { o, lang, locale } = props;
  const day = (iso: string) => {
    const [y, m, d] = formatDay(iso, (x) => x).split("-");
    if (y === undefined || m === undefined || d === undefined) return "";
    return localizeDigits(locale === "ar" ? `${d}/${m}/${y}` : `${y}-${m}-${d}`, locale);
  };
  const statusText = t(`orders.status.${o.status}`);
  const p = progress(o.status);
  const url = safeReceiptUrl(o.eReceipt);
  return (
    <Card variant="elevated" style={{ gap: spacing.lg, paddingVertical: 20 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" secondary>{t("orders.storeEyebrow")}</Text>
          <Text variant="quote">{o.storeName}</Text>
        </View>
        <Badge label={statusText} kind={statusKind(o.status)} />
      </View>
      {o.lines.map((l) => (
        <View key={l.id} style={{ flexDirection: "row", gap: spacing.md, alignItems: "center" }}>
          <ItemArt title={l.title} seed={l.id} width={56} label={l.title} />
          <View style={{ flex: 1 }}>
            <Text variant="callout" numberOfLines={2}>{l.title}</Text>
            <Text variant="caption" secondary numeric>{`${localizeDigits(String(l.qty), locale)} × ${props.money(l.unitPrice)}`}</Text>
          </View>
          {returnable(o) && props.onReturnLine !== undefined ? (
            <TextAction label={t("orders.returnItem")} accessibilityLabel={t("orders.returnItemName", { title: l.title })} onPress={() => props.onReturnLine?.(l.id)} />
          ) : null}
        </View>
      ))}
      <Text variant="headline" numeric>{t("orders.total", { amount: props.money(o.total) })}</Text>

      <Text variant="headline" weight="600">{t("orders.trackingHeading")}</Text>
      {p.onPath ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("orders.progressName", { status: statusText })}>
          <Timeline items={p.steps.map((s) => ({
            key: s.step, label: t(`orders.status.${s.step}`), done: s.done, current: s.current,
          }))} />
        </View>
      ) : null}
      {o.shipment === null ? <Text variant="callout" secondary>{t("orders.noTracking")}</Text> : (
        <View style={{ gap: spacing.xs }}>
          <Text variant="callout">{t("orders.courier", { courier: o.shipment.courier, awb: o.shipment.awb })}</Text>
          {o.shipment.etaAt !== null ? <Text variant="callout" secondary>{t("orders.eta", { date: day(o.shipment.etaAt) })}</Text> : null}
          <View style={{ marginTop: spacing.sm }}>
            <Timeline items={trackingTimeline(o.shipment).map((e, i) => ({
              key: `${e.status}-${e.at}`, label: pickText(e.label, lang), meta: day(e.at), done: true, current: i === 0,
            }))} />
          </View>
        </View>
      )}

      {canCancel(o.status) ? (
        <Button variant="secondary" fullWidth disabled={props.busy} title={t("orders.cancel")} accessibilityLabel={t("orders.cancelName", { store: o.storeName })} onPress={() => props.onCancel(o.id)} />
      ) : o.status === "SHIPPED" || o.status === "OUT_FOR_DELIVERY" ? (
        <Text variant="caption" secondary>{t("orders.cannotCancel")}</Text>
      ) : null}
      {o.eReceipt !== null ? <Text variant="caption" secondary>{t("orders.receiptId", { uuid: o.eReceipt.uuid })}</Text> : null}
      {url !== null ? (
        <Button variant="ghost" icon="document-text-outline" title={t("orders.receiptOpen")} accessibilityLabel={t("orders.receiptName", { store: o.storeName })} onPress={() => void Linking.openURL(url)} />
      ) : (
        <Text variant="caption" secondary>{t("orders.receiptPending")}</Text>
      )}
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
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
      setConfirmId(null);
    }
  };

  const groups: readonly OrderGroup[] = state.status === "ready" ? state.groups : [];
  const open = groups.find((g) => g.id === openId) ?? null;
  const shown = filterOrders(groups, filter);
  // Arabic reads day-month-year; ISO order scrambles visually in RTL, so use dd/mm/yyyy there.
  const placed = (g: OrderGroup) => {
    const iso = formatDay(g.placedAt, (x) => x);
    const [y, m, d] = iso.split("-");
    const shown = locale === "ar" && y !== undefined && m !== undefined && d !== undefined ? `${d}/${m}/${y}` : iso;
    return localizeDigits(shown, locale);
  };

  return (
    <Screen title={open === null ? t("orders.title") : t("orders.orderNo", { id: localizeDigits(orderNumber(open.id), locale) })}
      {...(open !== null ? { onBack: () => setOpenId(null), backLabel: t("orders.back") } : props.onBack !== undefined ? { onBack: props.onBack, backLabel: t("common.back") } : {})}>
      {state.status === "loading" ? <LoadingState label={t("orders.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState offline={state.offline} title={t(state.offline ? "orders.offlineTitle" : "orders.errorTitle")}
          description={t(state.offline ? "orders.offlineBody" : "orders.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
      ) : null}
      {state.status === "ready" && groups.length === 0 ? (
        <EmptyState illustration={<Illustration name="noOrders" size={120} />} title={t("orders.emptyTitle")} description={t("orders.emptyBody")}
          {...(props.onShop !== undefined ? { actionTitle: t("bag.emptyAction"), onAction: props.onShop } : {})} />
      ) : null}
      {message !== null ? <Banner tone={message.tone} message={message.text} /> : null}
      {open === null && groups.length > 0 ? (
        <>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {FILTERS.map((f) => <Chip key={f} label={t(`orders.filter.${f}`)} selected={filter === f} onPress={() => setFilter(f)} />)}
          </View>
          {shown.length === 0 ? <Text variant="callout" secondary>{t("orders.filterEmpty")}</Text> : null}
          {shown.map((g, gi) => {
            const key = groupStatusKey(g);
            const first = g.sellerOrders[0];
            const thumbs = g.sellerOrders.flatMap((o) => o.lines).slice(0, 4);
            return (
              <Flow key={g.id} index={gi}><Card variant="elevated" style={{ gap: spacing.md }}>
                <PressScale testID={`order-row-${g.id}`} accessibilityRole="button" accessibilityLabel={t("orders.openOrder", { id: orderNumber(g.id) })} onPress={() => setOpenId(g.id)}
                  haptic={false} scale={0.99} innerStyle={{ minHeight: minTouchTarget, gap: spacing.sm }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}>
                    <Text variant="caption" secondary>{t("orders.placedOn", { date: placed(g) })}</Text>
                    <Badge label={t(`orders.status.${key}`)} kind={statusKind(key)} />
                  </View>
                  {thumbs.length > 0 ? (
                    <View style={{ flexDirection: "row", gap: spacing.sm }}>
                      {thumbs.map((l) => <ItemArt key={l.id} title={l.title} seed={l.id} width={64} />)}
                    </View>
                  ) : null}
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text variant="title2" weight="600" numeric>{money(g.total)}</Text>
                    <Icon name="chevron-forward" directional size={18} color="textSecondary" />
                  </View>
                  {first !== undefined && g.sellerOrders.length > 1 ? <Text variant="caption" secondary>{t(pluralKey("orders.sellersCount", g.sellerOrders.length), { count: localizeDigits(String(g.sellerOrders.length), locale) })}</Text> : null}
                </PressScale>
                {resumable(g) ? (
                  <View style={{ gap: spacing.sm }}>
                    <Text variant="caption" color="danger">{t("orders.pendingPayment")}</Text>
                    {props.onResumePayment !== undefined ? <Button title={t("orders.resume")} fullWidth onPress={() => props.onResumePayment?.(g.id)} /> : null}
                  </View>
                ) : null}
              </Card></Flow>
            );
          })}
        </>
      ) : null}
      {open !== null ? (
        <>
          <Text variant="caption" secondary>{t("orders.placedOn", { date: placed(open) })}</Text>
          {open.sellerOrders.map((o, i) => (
            <Flow key={o.id} index={i}>
              <SellerOrderBlock o={o} lang={lang} locale={locale} money={money} busy={busy} onCancel={(id) => setConfirmId(id)} onReturnLine={props.onReturnLine} />
            </Flow>
          ))}
          {resumable(open) && props.onResumePayment !== undefined ? (
            <Button title={t("orders.resume")} fullWidth onPress={() => props.onResumePayment?.(open.id)} />
          ) : null}
        </>
      ) : null}
      <BottomSheet visible={confirmId !== null} onClose={() => setConfirmId(null)} title={t("orders.cancelTitle")} closeLabel={t("common.close")}>
        <Text variant="callout" secondary>{t("orders.cancelBody")}</Text>
        <Button variant="destructive" fullWidth loading={busy} title={t("orders.cancelConfirm")} onPress={() => { if (confirmId !== null) void cancel(confirmId); }} />
        <Button variant="ghost" fullWidth title={t("orders.keepOrder")} onPress={() => setConfirmId(null)} />
      </BottomSheet>
    </Screen>
  );
}
