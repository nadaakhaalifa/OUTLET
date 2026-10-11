import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, Text } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { Chip } from "../search/Chip";
import { newIdempotencyKey } from "./idempotency";
import {
  PAUSE_MONTH_OPTIONS, TRIAL_REMINDER_DAYS_BEFORE, buildPlus, defaultPlanId, firstChargeAt, formatCairoDate, plusFailureState,
  type MemberView, type PlanOption, type PlusPort, type PlusScreenState, type PlusSnapshot, type PlusView,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

const BENEFITS = ["freeDelivery", "earlyAccess", "coins", "freeReturns", "plusDay", "voucher", "birthday", "support"] as const;

type Money = (minor: bigint) => string;
type Notice = "subscribed" | "cancelled" | "paused" | "switched" | null;

function Savings(props: { view: PlusView; money: Money; num: (n: number) => string }) {
  const { t } = useTranslation();
  const s = props.view.savings;
  return (
    <Card>
      <Text variant="heading">{t("plus.savings.title")}</Text>
      <Text>{s.hasSavings ? t("plus.savings.total", { amount: props.money(s.total), count: props.num(s.orders) }) : t("plus.savings.none")}</Text>
    </Card>
  );
}

function Paywall(props: {
  view: PlusView; snapshot: PlusSnapshot; money: Money; num: (n: number) => string; locale: DisplayLocale; now: number;
  busy: boolean; failed: boolean; onSubscribe: (planId: string) => void;
}) {
  const { t } = useTranslation();
  const { view } = props;
  const [selected, setSelected] = useState<string | null>(() => defaultPlanId(props.snapshot.plans));
  const chosen = view.options.find((o) => o.plan.id === selected) ?? null;
  const blocked = view.purchaseBlocker !== null;
  const trial = view.showTrial && chosen !== null && chosen.plan.trialDays > 0;
  const periodWord = (o: PlanOption) => t(`plus.period.${o.plan.interval}`);
  return (
    <>
      <Text secondary>{t("plus.subtitle")}</Text>
      {view.purchaseBlocker === "ageGate" ? (
        <Banner tone="info" message={`${t("plus.ageGate.title", { age: props.num(view.minAge) })}. ${t("plus.ageGate.body")}`} />
      ) : null}
      {view.purchaseBlocker === "salesDisabled" ? <Banner tone="info" message={t("plus.salesDisabled")} /> : null}
      {view.purchaseBlocker === "noPlans" ? <EmptyState title={t("plus.noPlansTitle")} description={t("plus.noPlansBody")} /> : null}
      {view.options.length > 0 ? (
        <Card>
          <Text variant="heading">{t("plus.plansHeading")}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("plus.plansHeading")} style={{ gap: spacing.sm }}>
            {view.options.map((o) => (
              <View key={o.plan.id} style={{ gap: spacing.xs }}>
                <Chip
                  role="radio"
                  selected={o.plan.id === selected}
                  disabled={blocked}
                  label={t(`plus.priceLine.${o.plan.interval}`, { amount: props.money(o.plan.price) })}
                  accessibilityLabel={t("plus.planName", { plan: t(`plus.plan.${o.plan.interval}`), amount: props.money(o.plan.price) })}
                  onPress={() => setSelected(o.plan.id)}
                />
                {o.pitch !== null ? (
                  <>
                    <Text style={{ fontWeight: "600" }}>{t("plus.pitch", { pay: props.num(o.pitch.payMonths), free: props.num(o.pitch.freeMonths) })}</Text>
                    <Text variant="caption" secondary>
                      {t("plus.pitchSaving", { amount: props.money(o.pitch.saving), pct: props.num(o.pitch.savingPct) })}
                    </Text>
                  </>
                ) : null}
              </View>
            ))}
          </View>
        </Card>
      ) : null}
      <Card>
        <Text variant="heading">{t("plus.benefitsHeading")}</Text>
        {BENEFITS.map((b) => <Text key={b}>{t(`plus.benefit.${b}`)}</Text>)}
        <Text variant="caption" secondary>{t("plus.stylistNote")}</Text>
      </Card>
      {chosen !== null ? (
        <Card>
          <Text variant="heading">{t("plus.disclosure.heading")}</Text>
          {trial ? (
            <Text>
              {t("plus.disclosure.trial", {
                days: props.num(chosen.plan.trialDays),
                price: props.money(chosen.plan.price),
                date: formatCairoDate(firstChargeAt(chosen.plan, true, props.now), props.locale),
                reminder: props.num(TRIAL_REMINDER_DAYS_BEFORE),
              })}
            </Text>
          ) : null}
          <Text>{t("plus.disclosure.renews", { period: periodWord(chosen), price: props.money(chosen.plan.price) })}</Text>
          <Text>{t("plus.disclosure.cancel")}</Text>
          <Divider />
          {props.failed ? <Banner tone="error" message={t("plus.subscribeFailed")} /> : null}
          <Button
            title={trial ? t("plus.subscribeTrial") : t("plus.subscribe")}
            loading={props.busy}
            disabled={blocked || props.busy}
            onPress={() => props.onSubscribe(chosen.plan.id)}
          />
        </Card>
      ) : null}
    </>
  );
}

function Manage(props: {
  member: MemberView; money: Money; num: (n: number) => string; locale: DisplayLocale; periodEnd: number;
  busy: boolean; failed: boolean; onCancel: () => void; onPause: (months: number) => void; onSwitch: () => void;
}) {
  const { t } = useTranslation();
  const { member: m } = props;
  const date = (ms: number) => formatCairoDate(ms, props.locale);
  const has = (a: string) => m.actions.some((x) => x.action === a);
  return (
    <>
      <Card>
        <Text variant="heading">{t(`plus.status.${m.status}`)}</Text>
        {m.plan !== null ? (
          <Text secondary>{t(`plus.priceLine.${m.plan.interval}`, { amount: props.money(m.plan.price) })}</Text>
        ) : null}
        {m.status === "ACTIVE" ? <Text>{t("plus.manage.renewsOn", { date: date(props.periodEnd) })}</Text> : null}
        {m.trialReminderAt !== null && m.firstChargeAt !== null ? (
          <Text>{t("plus.manage.trialReminder", { reminder: date(m.trialReminderAt), charge: date(m.firstChargeAt) })}</Text>
        ) : null}
        {m.status === "PAST_DUE" && m.graceEndsAt !== null ? (
          <Banner tone="warning" message={t("plus.manage.pastDue", { date: date(m.graceEndsAt) })} />
        ) : null}
        {m.status === "CANCELLED_AT_PERIOD_END" && m.benefitsEndAt !== null ? (
          <Text>{t("plus.manage.endsOn", { date: date(m.benefitsEndAt) })}</Text>
        ) : null}
        {m.status === "PAUSED" && m.pausedUntil !== null ? <Text>{t("plus.manage.pausedUntil", { date: date(m.pausedUntil) })}</Text> : null}
      </Card>
      {props.failed ? <Banner tone="error" message={t("plus.actionFailed")} /> : null}
      {m.actions.length > 0 ? (
        <Card>
          <Text variant="heading">{t("plus.manage.heading")}</Text>
          {has("pause") ? (
            <View style={{ gap: spacing.sm }}>
              <Text secondary>{t("plus.pause.heading")}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {PAUSE_MONTH_OPTIONS.map((n) => (
                  <Chip
                    key={n}
                    selected={false}
                    disabled={props.busy}
                    label={localizeDigits(String(n), props.locale)}
                    accessibilityLabel={t("plus.pause.optionName", { months: props.num(n) })}
                    onPress={() => props.onPause(n)}
                  />
                ))}
              </View>
            </View>
          ) : null}
          {has("switchPlan") && m.switchTarget !== null ? (
            <View style={{ gap: spacing.xs }}>
              <Button
                variant="secondary"
                title={t("plus.switch.toYearly", { price: props.money(m.switchTarget.price) })}
                disabled={props.busy}
                onPress={props.onSwitch}
              />
              <Text variant="caption" secondary>{t("plus.switch.note")}</Text>
            </View>
          ) : null}
          {has("cancel") ? (
            <View style={{ gap: spacing.xs }}>
              <Button variant="secondary" title={t("plus.cancel.action")} disabled={props.busy} onPress={props.onCancel} />
              <Text variant="caption" secondary>{t("plus.cancel.note", { date: date(props.periodEnd) })}</Text>
            </View>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

/** Dev fixtures only; production wiring replaces the port when the API client lands. */
export function PlusScreen(props: { port?: PlusPort; now?: () => number }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<PlusPort>(() => props.port ?? getFeaturePorts().plus, [props.port]);
  const [state, setState] = useState<PlusScreenState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const keys = useRef(new Map<string, string>());
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const num = useCallback((n: number) => localizeDigits(String(n), locale), [locale]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(plusFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  /** One idempotency key per attempt: a retry after a timeout replays the same key. */
  const run = async (done: Exclude<Notice, null>, attempt: string, f: (key: string) => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setNotice(null);
    const key = keys.current.get(attempt) ?? newIdempotencyKey();
    keys.current.set(attempt, key);
    try {
      if (await f(key)) {
        keys.current.delete(attempt);
        setNotice(done);
        await load(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const view = snapshot !== null ? buildPlus(snapshot) : null;
  const now = (props.now ?? Date.now)();
  return (
    <Screen>
      <Text variant="title">{t("plus.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("plus.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "plus.offlineTitle" : "plus.errorTitle")}
          description={t(state.offline ? "plus.offlineBody" : "plus.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {notice !== null ? <Banner tone="info" message={t(`plus.done.${notice}`)} /> : null}
      {snapshot !== null && view !== null && view.mode === "paywall" ? (
        <>
          <Paywall
            view={view} snapshot={snapshot} money={money} num={num} locale={locale} now={now} busy={busy} failed={failed}
            onSubscribe={(planId) => void run("subscribed", `subscribe:${planId}`, async (key) => {
              const out = await port.subscribe(planId, key);
              if (out.kind === "subscribed") return true;
              await load(true);
              return false;
            })}
          />
          <Savings view={view} money={money} num={num} />
        </>
      ) : null}
      {snapshot !== null && view !== null && view.mode === "manage" && view.member !== null && snapshot.membership !== null ? (
        <>
          <Manage
            member={view.member} money={money} num={num} locale={locale} periodEnd={snapshot.membership.periodEnd} busy={busy} failed={failed}
            onCancel={() => void run("cancelled", "cancel", async (key) => { await port.cancel(key); return true; })}
            onPause={(months) => void run("paused", `pause:${months}`, async (key) => { await port.pause(months, key); return true; })}
            onSwitch={() => {
              const target = view.member?.switchTarget;
              if (target !== null && target !== undefined) void run("switched", `switch:${target.id}`, async (key) => { await port.switchPlan(target.id, key); return true; });
            }}
          />
          <Savings view={view} money={money} num={num} />
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
