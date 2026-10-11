import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, ErrorState, LoadingState, Screen, SwitchRow, Text, TextField } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { clockFromServer } from "../drops/serverClock";
import {
  BUDGET_DELETE_HOURS, CAP_MODES, HARD_UNLOCK_HOURS, SOFT_HOLD_MS, availableAfterPayday, budgetFailureState,
  capState, holdSeconds, holdState, parseAmountEgp, parsePayday, remainingNow, unlockState, wishlistAffordability,
  type BudgetPort, type BudgetScreenState, type BudgetSettings, type CapMode,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

export function BudgetScreen(props: { port?: BudgetPort; now?: () => number; newKey?: () => string }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<BudgetPort>(() => props.port ?? getFeaturePorts().budget, [props.port]);
  const nowFn = props.now ?? Date.now;
  const counter = useRef(0);
  const newKey = props.newKey ?? (() => `budget-${Date.now()}-${(counter.current += 1)}`);
  const currency = t("common.currency");
  const money = useCallback((m: bigint) => formatMoney(m, locale, currency), [locale, currency]);
  const num = (n: number) => localizeDigits(String(n), locale);

  const [state, setState] = useState<BudgetScreenState>({ status: "loading" });
  const [includeBag, setIncludeBag] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [paydayText, setPaydayText] = useState("");
  const [fieldErr, setFieldErr] = useState<{ amount: boolean; payday: boolean }>({ amount: false, payday: false });
  const [capMode, setCapMode] = useState<CapMode>("off");
  const [msg, setMsg] = useState<"saved" | "saveFailed" | "unlockFailed" | null>(null);
  const [holdStart, setHoldStart] = useState<number | null>(null);
  const [tick, setTick] = useState(() => nowFn());
  const [clockOffset, setClockOffset] = useState(0);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      if (!(await port.consent())) {
        setState({ status: "consent", failed: false });
        return;
      }
      const summary = await port.summary();
      setClockOffset(clockFromServer(summary.serverNowMs, nowFn()).offsetMs);
      if (summary.settings !== null) {
        setAmountText(String(summary.settings.amount / 100n));
        setPaydayText(String(summary.settings.payday));
        setCapMode(summary.settings.capMode);
      }
      setState({ status: "ready", summary });
    } catch (e) {
      setState(budgetFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const timing = holdStart !== null || (state.status === "ready" && state.summary.unlockAtMs !== null);
  useEffect(() => {
    if (!timing) return;
    const id = setInterval(() => setTick(nowFn()), 1000);
    return () => clearInterval(id);
  }, [timing]);

  const setConsent = async (granted: boolean) => {
    try {
      await port.setConsent(granted);
      if (granted) await load();
      else setState({ status: "consent", failed: false });
    } catch {
      setState({ status: "consent", failed: true });
    }
  };

  const save = async () => {
    const a = parseAmountEgp(amountText);
    const p = parsePayday(paydayText);
    setFieldErr({ amount: !a.ok, payday: p === null });
    if (!a.ok || p === null) return;
    const settings: BudgetSettings = { amount: a.value, payday: p, capMode };
    try {
      await port.saveSettings(settings, newKey());
      setMsg("saved");
      await load();
    } catch {
      setMsg("saveFailed");
    }
  };

  const requestUnlock = async () => {
    try {
      const r = await port.requestUnlock(newKey());
      if (state.status === "ready") setState({ status: "ready", summary: { ...state.summary, unlockAtMs: r.unlockAtMs } });
      setMsg(null);
    } catch {
      setMsg("unlockFailed");
    }
  };

  const dateOf = (ms: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(ms));

  const ready = state.status === "ready" ? state.summary : null;
  const rem = ready !== null ? remainingNow(ready, includeBag) : null;
  const after = ready !== null ? availableAfterPayday(ready) : null;
  const cap = ready !== null && ready.settings !== null ? capState(ready.settings.capMode, rem) : { kind: "off" as const };
  const hold = holdState(holdStart, tick);
  const unlock = ready !== null ? unlockState(ready.unlockAtMs, { offsetMs: clockOffset }, tick) : { kind: "none" as const };

  return (
    <Screen>
      <Text variant="title">{t("budget.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("budget.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "budget.offlineTitle" : "budget.errorTitle")}
          description={t(state.offline ? "budget.offlineBody" : "budget.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {state.status === "consent" ? (
        <Card>
          <Text variant="heading">{t("budget.consentTitle")}</Text>
          <Text>{t("budget.consentBody", { hours: num(BUDGET_DELETE_HOURS) })}</Text>
          {state.failed ? <Banner tone="error" message={t("budget.consentFailed")} /> : null}
          <Button title={t("budget.consentGrant")} onPress={() => void setConsent(true)} />
        </Card>
      ) : null}

      {ready !== null ? (
        <>
          <Card>
            <TextField
              label={`${t("budget.amountLabel")} (${currency})`}
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="numeric"
              {...(fieldErr.amount ? { error: t("budget.amountInvalid") } : {})}
            />
            <TextField
              label={t("budget.paydayLabel")}
              value={paydayText}
              onChangeText={setPaydayText}
              keyboardType="numeric"
              helper={t("budget.paydayClamped")}
              {...(fieldErr.payday ? { error: t("budget.paydayInvalid") } : {})}
            />
            <Text variant="caption" secondary>{t("budget.capHeading")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
              {CAP_MODES.map((m) => (
                <Button
                  key={m}
                  variant={m === capMode ? "primary" : "secondary"}
                  title={t(`budget.capMode.${m}`)}
                  accessibilityLabel={t("budget.capModeName", { mode: t(`budget.capMode.${m}`) })}
                  onPress={() => setCapMode(m)}
                />
              ))}
            </View>
            <Button title={t("budget.saveSettings")} onPress={() => void save()} />
            {msg === "saved" ? <Banner tone="info" message={t("budget.saved")} /> : null}
            {msg === "saveFailed" ? <Banner tone="error" message={t("budget.saveFailed")} /> : null}
          </Card>

          {rem === null || after === null ? (
            <Card>
              <Text variant="heading">{t("budget.emptyTitle")}</Text>
              <Text secondary>{t("budget.emptyBody")}</Text>
            </Card>
          ) : (
            <Card>
              <Text variant="heading">{t("budget.remainingNow", { amount: money(rem.display) })}</Text>
              {rem.over ? <Banner tone="warning" message={t("budget.overBy", { amount: money(rem.overBy) })} /> : null}
              <Text>{t("budget.afterPayday", { amount: money(after) })}</Text>
              <Text variant="caption" secondary>{t("budget.spent", { amount: money(ready.spentThisCycle) })}</Text>
              <Text variant="caption" secondary>{t("budget.installmentsDue", { amount: money(ready.installmentsDueThisCycle) })}</Text>
              <SwitchRow label={t("budget.includeBag")} value={includeBag} onValueChange={setIncludeBag} />
              {includeBag ? <Text variant="caption" secondary>{t("budget.bagIncluded", { amount: money(ready.bagTotal) })}</Text> : null}
            </Card>
          )}

          {ready.installments.length > 0 ? (
            <Card>
              <Text variant="heading">{t("budget.installmentsHeading")}</Text>
              {ready.installments.map((i) => (
                <Text key={i.id}>
                  {t(i.source === "provider" ? "budget.installmentLineProvider" : "budget.installmentLineUser", { provider: i.provider, amount: money(i.monthly) })}
                </Text>
              ))}
            </Card>
          ) : null}

          {ready.settings !== null ? (
            <Card>
              <Text variant="heading">{t("budget.affordableHeading")}</Text>
              {wishlistAffordability(ready, includeBag).length === 0 ? <Text secondary>{t("budget.affordableEmpty")}</Text> : null}
              {wishlistAffordability(ready, includeBag).map(({ item, status }) => (
                <View key={item.id} style={{ gap: spacing.xs }}>
                  <Text>{`${item.title}, ${money(item.price)}`}</Text>
                  <Text variant="caption" secondary>
                    {t(status === "now" ? "budget.affordableNow" : status === "afterPayday" ? "budget.affordableLater" : "budget.affordableNo")}
                  </Text>
                </View>
              ))}
            </Card>
          ) : null}

          <Card>
            <Text variant="heading">{t("budget.capHeading")}</Text>
            {cap.kind === "off" ? <Text secondary>{t("budget.capOff")}</Text> : null}
            {cap.kind === "notReached" ? <Text secondary>{t("budget.capNotReached")}</Text> : null}
            {cap.kind === "softReached" ? (
              <>
                <Banner tone="warning" message={t("budget.capSoftReached", { seconds: num(SOFT_HOLD_MS / 1000) })} />
                {hold === null ? (
                  <Button variant="secondary" title={t("budget.capSoftHold", { seconds: num(SOFT_HOLD_MS / 1000) })} onPress={() => setHoldStart(nowFn())} />
                ) : hold.done ? (
                  <Banner tone="info" message={t("budget.capSoftReady")} />
                ) : (
                  <>
                    <Text accessibilityRole="text">{t("budget.capSoftCounting", { seconds: num(holdSeconds(hold)) })}</Text>
                    <Button variant="secondary" title={t("budget.capSoftCancel")} onPress={() => setHoldStart(null)} />
                  </>
                )}
              </>
            ) : null}
            {cap.kind === "hardReached" ? (
              <>
                <Banner tone="warning" message={t("budget.capHardReached", { hours: num(HARD_UNLOCK_HOURS) })} />
                {unlock.kind === "none" ? <Button variant="secondary" title={t("budget.capHardRequest")} onPress={() => void requestUnlock()} /> : null}
                {unlock.kind === "pending" ? <Banner tone="info" message={t("budget.capHardPending", { date: dateOf(unlock.unlockAtMs) })} /> : null}
                {unlock.kind === "ready" ? <Banner tone="info" message={t("budget.capHardReady")} /> : null}
                {msg === "unlockFailed" ? <Banner tone="error" message={t("budget.capUnlockFailed")} /> : null}
              </>
            ) : null}
          </Card>

          <Divider />
          <Text variant="caption" secondary>{t("budget.notAdvice")}</Text>
          <Button variant="secondary" title={t("budget.consentWithdraw")} onPress={() => void setConsent(false)} />
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
