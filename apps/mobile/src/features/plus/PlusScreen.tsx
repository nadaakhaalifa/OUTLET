import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Button, Chip, Divider, EmptyState, ErrorState, Eyebrow, FullBleedHero, Icon, PressScale, Reveal, Screen, Skeleton, StickyBar, Text, useTheme } from "../../ui";
import { HeroArt } from "../../art";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { newIdempotencyKey } from "./idempotency";
import {
  PAUSE_MONTH_OPTIONS, TRIAL_REMINDER_DAYS_BEFORE, buildPlus, defaultPlanId, firstChargeAt, formatCairoDate, plusFailureState,
  type MemberView, type PlanOption, type PlusPort, type PlusScreenState, type PlusView,
} from "./model";
import { getFeaturePorts } from "../../state/ports";
import { FamilyPlansSection } from "../family/FamilyPlansSection";

const BENEFITS = ["freeDelivery", "earlyAccess", "coins", "freeReturns", "plusDay", "voucher", "birthday", "support"] as const;

type Money = (minor: bigint) => string;
type Notice = "subscribed" | "cancelled" | "paused" | "switched" | null;

/** Savings meter from the server ledger only; says nothing when there is nothing to report. */
function Savings(props: { view: PlusView; money: Money; num: (n: number) => string }) {
  const { t } = useTranslation();
  const s = props.view.savings;
  return (
    <View style={{ gap: 6 }}>
      <Eyebrow color="plus" secondary={false}>{t("plus.savings.title")}</Eyebrow>
      {s.hasSavings ? (
        <>
          <Text variant="display" color="plus" numeric>{props.money(s.total)}</Text>
          <Text variant="caption" secondary>{t("plus.savings.orders", { count: props.num(s.orders) })}</Text>
        </>
      ) : (
        <Text variant="callout" secondary>{t("plus.savings.none")}</Text>
      )}
    </View>
  );
}

function PlanRow(props: { option: PlanOption; selected: boolean; disabled: boolean; money: Money; num: (n: number) => string; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { plan, pitch } = props.option;
  return (
    <PressScale
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      accessibilityLabel={t("plus.planName", { plan: t(`plus.plan.${plan.interval}`), amount: props.money(plan.price) })}
      innerStyle={{ borderWidth: props.selected ? 1.5 : 1, borderColor: props.selected ? colors.plus : colors.hairline, padding: 16, gap: 6, minHeight: 72, borderRadius: 18 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Icon name={props.selected ? "radio-button-on" : "radio-button-off"} size={20} color={props.selected ? "plus" : "textSecondary"} />
        <View style={{ flex: 1 }}>
          <Text variant="headline" accessibilityRole="none">{t(`plus.plan.${plan.interval}`)}</Text>
        </View>
        <Text variant="headline" numeric accessibilityRole="none">{t(`plus.priceLine.${plan.interval}`, { amount: props.money(plan.price) })}</Text>
      </View>
      {pitch !== null ? (
        <View style={{ paddingStart: 32, gap: 2 }}>
          <Text variant="callout" color="plus" weight="500" accessibilityRole="none">{t("plus.pitch", { pay: props.num(pitch.payMonths), free: props.num(pitch.freeMonths) })}</Text>
          <Text variant="caption" secondary accessibilityRole="none">{t("plus.pitchSaving", { amount: props.money(pitch.saving), pct: props.num(pitch.savingPct) })}</Text>
        </View>
      ) : null}
    </PressScale>
  );
}

function Benefits() {
  const { t } = useTranslation();
  return (
    <View style={{ gap: 12 }}>
      <Eyebrow>{t("plus.benefitsHeading")}</Eyebrow>
      {BENEFITS.map((b) => (
        <View key={b} style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 2 }}><Icon name="checkmark" size={16} color="plus" /></View>
          <Text style={{ flex: 1 }} accessibilityRole="none">{t(`plus.benefit.${b}`)}</Text>
        </View>
      ))}
      <Text variant="caption" secondary>{t("plus.stylistNote")}</Text>
    </View>
  );
}

function PlusHeader(props: { subtitle: string }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: 14 }}>
      <FullBleedHero
        imageNode={<HeroArt variant="plus" style={{ width: "100%", height: "100%", aspectRatio: undefined }} />}
        aspectRatio={1.15}
        cornerRadius={20}
        bleed={false}
        eyebrow={t("plus.eyebrow")}
        title={t("plus.title")}
      />
      <Reveal index={1}><Text variant="lede" secondary>{props.subtitle}</Text></Reveal>
    </View>
  );
}

/** The disclosure sits directly above the Join button, in the same sticky bar, so it is always read before paying. */
function PaywallFooter(props: {
  chosen: PlanOption | null; view: PlusView; money: Money; num: (n: number) => string; locale: DisplayLocale; now: number;
  busy: boolean; failed: boolean; onSubscribe: () => void;
}) {
  const { t } = useTranslation();
  const { chosen, view } = props;
  const [open, setOpen] = useState(false);
  if (chosen === null) return null;
  const blocked = view.purchaseBlocker !== null;
  const trial = view.showTrial && chosen.plan.trialDays > 0;
  return (
    <StickyBar>
      <View style={{ gap: 8 }}>
        {trial ? (
          <Text variant="caption" secondary>
            {t("plus.disclosure.trial", {
              days: props.num(chosen.plan.trialDays),
              price: props.money(chosen.plan.price),
              date: formatCairoDate(firstChargeAt(chosen.plan, true, props.now), props.locale),
              reminder: props.num(TRIAL_REMINDER_DAYS_BEFORE),
            })}
          </Text>
        ) : null}
        <Text variant="caption" secondary>{t("plus.disclosure.renews", { period: t(`plus.period.${chosen.plan.interval}`), price: props.money(chosen.plan.price) })}</Text>
        {open ? <Text variant="caption" secondary>{t("plus.disclosure.cancel")}</Text> : null}
        <PressScale onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={open ? t("plus.disclosure.less") : t("plus.disclosure.more")} hitSlop={8} testID="plus-disclosure-toggle">
          <Text variant="caption" weight="600">{open ? t("plus.disclosure.less") : t("plus.disclosure.more")}</Text>
        </PressScale>
        {props.failed ? <Banner tone="error" message={t("plus.subscribeFailed")} /> : null}
        <Button variant="brand" title={trial ? t("plus.subscribeTrial") : t("plus.subscribe")} loading={props.busy} disabled={blocked || props.busy} onPress={props.onSubscribe} />
      </View>
    </StickyBar>
  );
}

function Paywall(props: { view: PlusView; selected: string | null; onSelect: (id: string) => void; money: Money; num: (n: number) => string }) {
  const { t } = useTranslation();
  const { view } = props;
  const blocked = view.purchaseBlocker !== null;
  return (
    <>
      <PlusHeader subtitle={t("plus.subtitle")} />
      {view.purchaseBlocker === "ageGate" ? (
        <Banner tone="info" message={`${t("plus.ageGate.title", { age: props.num(view.minAge) })}. ${t("plus.ageGate.body")}`} />
      ) : null}
      {view.purchaseBlocker === "salesDisabled" ? <Banner tone="info" message={t("plus.salesDisabled")} /> : null}
      {view.purchaseBlocker === "noPlans" ? <EmptyState title={t("plus.noPlansTitle")} description={t("plus.noPlansBody")} /> : null}
      {view.options.length > 0 ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={t("plus.plansHeading")} style={{ gap: 10 }}>
          <Eyebrow>{t("plus.plansHeading")}</Eyebrow>
          {view.options.map((o, i) => (
            <Reveal key={o.plan.id} index={i + 2}>
              <PlanRow option={o} selected={o.plan.id === props.selected} disabled={blocked} money={props.money} num={props.num} onPress={() => props.onSelect(o.plan.id)} />
            </Reveal>
          ))}
        </View>
      ) : null}
      <Divider />
      <Benefits />
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
      <PlusHeader subtitle={m.plan !== null ? t(`plus.priceLine.${m.plan.interval}`, { amount: props.money(m.plan.price) }) : t("plus.subtitle")} />
      <View style={{ gap: 8 }}>
        <Text variant="title2" color="plus">{t(`plus.status.${m.status}`)}</Text>
        {m.status === "ACTIVE" ? <Text secondary>{t("plus.manage.renewsOn", { date: date(props.periodEnd) })}</Text> : null}
        {m.trialReminderAt !== null && m.firstChargeAt !== null ? (
          <Text secondary>{t("plus.manage.trialReminder", { reminder: date(m.trialReminderAt), charge: date(m.firstChargeAt) })}</Text>
        ) : null}
        {m.status === "PAST_DUE" && m.graceEndsAt !== null ? <Banner tone="warning" message={t("plus.manage.pastDue", { date: date(m.graceEndsAt) })} /> : null}
        {m.status === "CANCELLED_AT_PERIOD_END" && m.benefitsEndAt !== null ? <Text secondary>{t("plus.manage.endsOn", { date: date(m.benefitsEndAt) })}</Text> : null}
        {m.status === "PAUSED" && m.pausedUntil !== null ? <Text secondary>{t("plus.manage.pausedUntil", { date: date(m.pausedUntil) })}</Text> : null}
      </View>
      {props.failed ? <Banner tone="error" message={t("plus.actionFailed")} /> : null}
      {m.actions.length > 0 ? (
        <View style={{ gap: 18 }}>
          <Divider />
          <Eyebrow>{t("plus.manage.heading")}</Eyebrow>
          {has("pause") ? (
            <View style={{ gap: 10 }}>
              <Text secondary>{t("plus.pause.heading")}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {PAUSE_MONTH_OPTIONS.map((n) => (
                  <Chip key={n} selected={false} disabled={props.busy} label={t("plus.pause.optionName", { months: props.num(n) })} onPress={() => props.onPause(n)} />
                ))}
              </View>
            </View>
          ) : null}
          {has("switchPlan") && m.switchTarget !== null ? (
            <View style={{ gap: 6 }}>
              <Button variant="secondary" title={t("plus.switch.toYearly", { price: props.money(m.switchTarget.price) })} disabled={props.busy} onPress={props.onSwitch} />
              <Text variant="caption" secondary>{t("plus.switch.note")}</Text>
            </View>
          ) : null}
          {has("cancel") ? (
            <View style={{ gap: 6 }}>
              <Button variant="secondary" title={t("plus.cancel.action")} disabled={props.busy} onPress={props.onCancel} />
              <Text variant="caption" secondary>{t("plus.cancel.note", { date: date(props.periodEnd) })}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** `guest`: a signed-out shopper reads benefits, prices and terms; there is no Subscribe button (Plus is added at checkout). */
export function PlusScreen(props: { port?: PlusPort; now?: () => number; guest?: boolean }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<PlusPort>(() => props.port ?? getFeaturePorts().plus, [props.port]);
  const [state, setState] = useState<PlusScreenState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const num = useCallback((n: number) => localizeDigits(String(n), locale), [locale]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      const snapshot = await port.load();
      setState({ status: "ready", snapshot });
      setSelected((cur) => cur ?? defaultPlanId(snapshot.plans));
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
  const subscribe = (planId: string) => void run("subscribed", `subscribe:${planId}`, async (key) => {
    const out = await port.subscribe(planId, key);
    if (out.kind === "subscribed") return true;
    await load(true);
    return false;
  });

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const view = snapshot !== null ? buildPlus(snapshot) : null;
  const now = (props.now ?? Date.now)();
  const chosen: PlanOption | null = view?.options.find((o) => o.plan.id === selected) ?? null;
  const guest = props.guest === true;
  const paywall = view !== null && view.mode === "paywall";
  return (
    <Screen
      onBack={() => router.back()}
      backLabel={t("common.back")}
      footer={!guest && paywall && snapshot !== null && view !== null ? (
        <PaywallFooter chosen={chosen} view={view} money={money} num={num} locale={locale} now={now} busy={busy} failed={failed} onSubscribe={() => { if (chosen !== null) subscribe(chosen.plan.id); }} />
      ) : undefined}
    >
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("plus.loading")} style={{ gap: 14 }}>
          <Skeleton height={300} radius={18} />
          <Skeleton width="80%" height={20} />
          <Skeleton height={72} radius={14} />
          <Skeleton height={72} radius={14} />
        </View>
      ) : null}
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
      {snapshot !== null && view !== null && paywall ? (
        <>
          <Paywall view={view} selected={selected} onSelect={setSelected} money={money} num={num} />
          {guest ? <Text variant="callout" secondary testID="plus-guest-line">{t("guestMe.plusLine")}</Text> : null}
          <Divider />
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
          <Divider />
          <Savings view={view} money={money} num={num} />
          <Divider />
          <Benefits />
        </>
      ) : null}
      {snapshot !== null ? <FamilyPlansSection /> : null}
    </Screen>
  );
}
