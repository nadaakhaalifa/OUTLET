import { useEffect, useMemo, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Illustration } from "../../art";
import { Badge, BottomSheet, Button, Card, Chip, EmptyState, PressScale, Reveal, Screen, Skeleton, Text, TextField, useToast } from "../../ui";
import { localizeDigits } from "../money-display";
import { Block, FailureView, Hairline, StaleBanner, useBrand, useLoad, useMoney } from "./kit";
import {
  ORDER_QUEUES, REJECT_REASONS, maskedBuyer, orderActions, queueOf, rejectValid, serverNow, slaCountdown, failureOf,
  type BrandOrder, type OrderAction, type OrderQueue, type RejectReason, type ReturnInspection,
} from "./model";

export function OrdersScreen() {
  const { t } = useTranslation();
  const toast = useToast();
  const { port, account, clock, locale } = useBrand();
  const money = useMoney();
  const orders = useLoad<readonly BrandOrder[]>("orders", () => port.listOrders());
  const returns = useLoad<readonly ReturnInspection[]>("returns", () => port.listReturns());
  const [queue, setQueue] = useState<OrderQueue>("awaiting");
  const [openId, setOpenId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<BrandOrder | null>(null);
  const [inspecting, setInspecting] = useState<ReturnInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [override, setOverride] = useState<Record<string, BrandOrder>>({});
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(id); }, []);

  const list = useMemo(() => {
    if (orders.state.status !== "ready") return [];
    return orders.state.data.map((o) => override[o.id] ?? o);
  }, [orders.state, override]);
  const counts = useMemo(() => {
    const c: Record<OrderQueue, number> = { awaiting: 0, toPack: 0, shipped: 0, returns: 0, done: 0 };
    list.forEach((o) => { c[queueOf(o.status)] += 1; });
    return c;
  }, [list]);
  const shown = list.filter((o) => queueOf(o.status) === queue).sort((a, b) => a.acceptByMs - b.acceptByMs);
  const open = list.find((o) => o.id === openId) ?? null;
  const n = (v: number) => localizeDigits(String(v), locale);
  const now = serverNow(clock, Date.now());

  const run = async (o: BrandOrder, action: OrderAction) => {
    setBusy(o.id);
    try {
      const next = action === "accept" ? await port.acceptOrder(o.id) : action === "pack" ? await port.packOrder(o.id) : await port.markReady(o.id);
      setOverride((m) => ({ ...m, [o.id]: next }));
      toast.show(t("brandMode.orders.actionDone"), "success");
    } catch (e) {
      const f = failureOf(e);
      toast.show(t(f === "conflict" ? "brandMode.orders.stale" : "brandMode.orders.actionFailed"), "error");
      if (f === "conflict") orders.reload();
    } finally {
      setBusy(null);
    }
  };
  const label = (o: BrandOrder) => t("brandMode.orders.orderNo", { id: o.id.replace(/^o-/, "#") });

  return (
    <Screen title={t("brandMode.orders.title")} onRefresh={() => { orders.reload(); returns.reload(); }}>
      {orders.state.status === "ready" ? <StaleBanner visible={orders.state.stale} /> : null}
      {orders.state.status === "loading" ? <View style={{ gap: 16 }}><Skeleton height={36} /><Skeleton height={90} /><Skeleton height={90} /></View> : null}
      {orders.state.status === "error" ? <FailureView failure={orders.state.failure} onRetry={orders.reload} /> : null}
      {orders.state.status === "ready" ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
            {ORDER_QUEUES.map((q) => <Chip key={q} label={`${t(`brandMode.orders.queues.${q}`)} ${n(counts[q])}`} selected={queue === q} onPress={() => setQueue(q)} />)}
          </ScrollView>
          {shown.length === 0 ? <EmptyState illustration={<Illustration name="noOrders" size={96} />} title={t("brandMode.orders.emptyTitle")} description={t("brandMode.orders.emptyBody")} /> : null}
          {shown.map((o, idx) => {
            const sla = slaCountdown(o.acceptByMs, now);
            const awaiting = queueOf(o.status) === "awaiting";
            const b = maskedBuyer(o.buyer, o.status);
            return (
              <Reveal key={o.id} index={idx % 8} style={{ marginBottom: 4 }}>
                <PressScale onPress={() => setOpenId(o.id)} accessibilityRole="button" accessibilityLabel={label(o)} scale={0.995}>
                  <Card variant="elevated" style={{ gap: 6 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                      <Text variant="headline">{label(o)}</Text>
                      <Text variant="body" numeric>{money(o.subtotal)}</Text>
                    </View>
                    <Text variant="callout" secondary numberOfLines={1}>{o.lines.map((l) => `${l.title}${l.qty > 1 ? ` ×${n(l.qty)}` : ""}`).join(" · ")}</Text>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text variant="caption" secondary>{t("brandMode.orders.buyerMasked", { name: b.firstName ?? "—", governorate: b.governorate })}</Text>
                      {awaiting ? <Text variant="caption" color={sla.level === "ok" ? "textSecondary" : "danger"} numeric>{sla.level === "breached" ? t("brandMode.dashboard.slaBreached") : t("brandMode.dashboard.slaLeft", { hours: n(sla.hours), minutes: n(sla.minutes) })}</Text> : <Badge label={t(`brandMode.orders.payment.${o.payment}`)} kind="neutral" />}
                    </View>
                  </Card>
                </PressScale>
              </Reveal>
            );
          })}
          {queue === "returns" && returns.state.status === "ready" && returns.state.data.length > 0 ? (
            <Block eyebrow={t("brandMode.orders.returnsTitle")}>
              {returns.state.data.map((r) => (
                <View key={r.id} style={{ gap: 8 }}>
                  <Text variant="body">{t("brandMode.orders.orderNo", { id: r.orderId.replace(/^o-/, "#") })}</Text>
                  <Text variant="caption" secondary>{t("brandMode.orders.returnReason", { reason: r.reason })}</Text>
                  {account.role === "owner" || account.role === "manager" || account.role === "warehouse" ? <Button title={t("brandMode.orders.inspect")} variant="secondary" onPress={() => setInspecting(r)} /> : null}
                </View>
              ))}
            </Block>
          ) : null}
        </>
      ) : null}

      <BottomSheet visible={open !== null} onClose={() => setOpenId(null)} title={open === null ? undefined : label(open)} closeLabel={t("brandMode.common.close")}>
        {open !== null ? <OrderDetail
          o={open} nowMs={now} busy={busy === open.id} money={money} role={account.role}
          onAction={(a) => {
            if (a === "reject") { setRejecting(open); setOpenId(null); }
            else if (a === "printLabel") {
              const url = open.awbUrl;
              if (url !== null) void Linking.openURL(url);
              else void port.labelUri(open.id).then((u) => Linking.openURL(u), (e: unknown) => toast.show(t(failureOf(e) === "unsupported" ? "brandMode.common.unsupportedBody" : "brandMode.orders.actionFailed"), "error"));
            }
            else if (a === "inspectReturn") { setQueue("returns"); setOpenId(null); }
            else void run(open, a);
          }} /> : null}
      </BottomSheet>

      <RejectSheet order={rejecting} onClose={() => setRejecting(null)} onConfirm={async (reason, note) => {
        if (rejecting === null) return;
        try {
          const next = await port.rejectOrder(rejecting.id, reason, note);
          setOverride((m) => ({ ...m, [rejecting.id]: next }));
          toast.show(t("brandMode.orders.actionDone"), "success");
        } catch {
          toast.show(t("brandMode.orders.actionFailed"), "error");
        }
        setRejecting(null);
      }} />
      <InspectSheet ret={inspecting} onClose={() => setInspecting(null)} onConfirm={async (result, note) => {
        if (inspecting === null) return;
        try {
          await port.inspectReturn(inspecting.id, result, note);
          toast.show(t("brandMode.orders.actionDone"), "success");
          orders.reload(); returns.reload();
        } catch {
          toast.show(t("brandMode.orders.actionFailed"), "error");
        }
        setInspecting(null);
      }} />
    </Screen>
  );
}

function OrderDetail(props: { o: BrandOrder; nowMs: number; busy: boolean; money: (m: bigint) => string; role: Parameters<typeof orderActions>[1]; onAction: (a: OrderAction) => void }) {
  const { t, i18n } = useTranslation();
  const { o } = props;
  const locale = i18n.language === "en" ? "en" : "ar";
  const n = (v: number) => localizeDigits(String(v), locale);
  const sla = slaCountdown(o.acceptByMs, props.nowMs);
  const actions = orderActions(o.status, props.role, sla.level === "breached");
  const b = maskedBuyer(o.buyer, o.status);
  const awaiting = queueOf(o.status) === "awaiting";
  return (
    <View style={{ gap: 14, paddingBottom: 8 }}>
      {o.lines.map((l) => (
        <View key={l.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Text variant="body" style={{ flex: 1 }}>{l.title}{l.sizeLabel !== null ? ` · ${l.sizeLabel}` : ""}{l.qty > 1 ? ` ×${n(l.qty)}` : ""}</Text>
          <Text variant="body" numeric>{props.money(l.unitPrice * BigInt(l.qty))}</Text>
        </View>
      ))}
      <Hairline />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text variant="callout" secondary>{t("brandMode.orders.subtotal")}</Text><Text variant="callout" numeric>{props.money(o.subtotal)}</Text>
      </View>
      {o.netToSeller !== null ? <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text variant="callout" secondary>{t("brandMode.orders.net")}</Text><Text variant="callout" numeric>{props.money(o.netToSeller)}</Text></View> : null}
      <Hairline />
      <Text variant="body">{t("brandMode.orders.buyerMasked", { name: b.firstName ?? "—", governorate: b.governorate })}</Text>
      <Text variant="caption" secondary>{b.phoneRelay !== null ? t("brandMode.orders.buyerRelay", { phone: b.phoneRelay }) : t("brandMode.orders.buyerHidden")}</Text>
      <Badge label={t(`brandMode.orders.payment.${o.payment}`)} kind="neutral" />
      {awaiting ? <Text variant="callout" color={sla.level === "ok" ? "textSecondary" : "danger"} numeric>{sla.level === "breached" ? t("brandMode.orders.slaClosed") : t("brandMode.dashboard.slaLeft", { hours: n(sla.hours), minutes: n(sla.minutes) })}</Text> : null}
      <View style={{ gap: 10 }}>
        {actions.includes("accept") ? <Button title={t("brandMode.orders.accept")} onPress={() => props.onAction("accept")} loading={props.busy} testID="brand-order-accept" /> : null}
        {actions.includes("pack") ? <Button title={t("brandMode.orders.pack")} onPress={() => props.onAction("pack")} loading={props.busy} /> : null}
        {actions.includes("printLabel") ? <Button title={t("brandMode.orders.printLabel")} icon="print-outline" variant="secondary" onPress={() => props.onAction("printLabel")} /> : null}
        {actions.includes("markReady") ? <Button title={t("brandMode.orders.markReady")} onPress={() => props.onAction("markReady")} loading={props.busy} /> : null}
        {actions.includes("inspectReturn") ? <Button title={t("brandMode.orders.inspect")} onPress={() => props.onAction("inspectReturn")} /> : null}
        {actions.includes("reject") ? <Button title={t("brandMode.orders.reject")} variant="ghost" onPress={() => props.onAction("reject")} testID="brand-order-reject" /> : null}
      </View>
    </View>
  );
}

function RejectSheet(props: { order: BrandOrder | null; onClose: () => void; onConfirm: (r: RejectReason, note: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (props.order !== null) { setReason(null); setNote(""); } }, [props.order]);
  const ok = rejectValid(reason, note);
  return (
    <BottomSheet visible={props.order !== null} onClose={props.onClose} title={t("brandMode.orders.rejectTitle")} closeLabel={t("brandMode.common.close")}>
      <View style={{ gap: 14 }}>
        <Text variant="callout" secondary>{t("brandMode.orders.rejectBody")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {REJECT_REASONS.map((r) => <Chip key={r} label={t(`brandMode.orders.rejectReasons.${r}`)} selected={reason === r} onPress={() => setReason(r)} />)}
        </View>
        <TextField label={t("brandMode.orders.rejectNote")} value={note} onChangeText={setNote} maxLength={500} error={reason === "other" && note.trim().length < 3 && note.length > 0 ? t("brandMode.orders.rejectNoteRequired") : undefined} />
        <Button title={t("brandMode.orders.rejectConfirm")} variant="destructive" disabled={!ok} loading={busy} onPress={() => { if (reason === null) return; setBusy(true); void props.onConfirm(reason, note).finally(() => setBusy(false)); }} />
      </View>
    </BottomSheet>
  );
}

function InspectSheet(props: { ret: ReturnInspection | null; onClose: () => void; onConfirm: (r: "accept" | "reject", note: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (props.ret !== null) setNote(""); }, [props.ret]);
  const go = (r: "accept" | "reject") => { setBusy(true); void props.onConfirm(r, note).finally(() => setBusy(false)); };
  return (
    <BottomSheet visible={props.ret !== null} onClose={props.onClose} title={t("brandMode.orders.inspectTitle")} closeLabel={t("brandMode.common.close")}>
      <View style={{ gap: 14 }}>
        <Text variant="callout" secondary>{t("brandMode.orders.inspectBody")}</Text>
        <TextField label={t("brandMode.orders.inspectNote")} value={note} onChangeText={setNote} maxLength={500} />
        <Button title={t("brandMode.orders.inspectAccept")} loading={busy} onPress={() => go("accept")} />
        <Button title={t("brandMode.orders.inspectReject")} variant="secondary" disabled={note.trim().length < 3 || busy} onPress={() => go("reject")} />
      </View>
    </BottomSheet>
  );
}
