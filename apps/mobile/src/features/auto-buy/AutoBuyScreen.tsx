import { Ticker } from "../../components/Ticker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Badge, Banner, Button, EmptyState, ErrorState, Eyebrow, Reveal, Screen, Skeleton, Text, useTheme } from "../../ui";
import { Illustration } from "../../art";
import { getFeaturePorts } from "../../state/ports";
import { formatMoney, localizeDigits } from "../money-display";
import { newIdempotencyKey } from "../plus/idempotency";
import { formatCairoDate } from "../plus/model";
import {
  autoBuyFailureState, buildRuleRows, cancelWindow, formatCairoClock, listClock,
  type AutoBuyAttempt, type AutoBuyPort, type AutoBuyScreenState, type DisplayLocale, type RuleRowView,
} from "./model";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Me > Auto-buy rules: every rule with its state, a one-tap cancel, and attempt notices with the cancel countdown. */
export function AutoBuyScreen(props: { port?: AutoBuyPort; onBack?: () => void; onOpenProduct?: (id: string) => void; now?: () => number }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<AutoBuyPort>(() => props.port ?? getFeaturePorts().autoBuy, [props.port]);
  const nowFn = props.now ?? Date.now;
  const [state, setState] = useState<AutoBuyScreenState>({ status: "loading" });
  // The server timestamp is captured together with the device time it arrived at (see cancelWindow).
  const [loadedAt, setLoadedAt] = useState<number>(() => nowFn());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const keys = useRef(new Map<string, string>());
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      const list = await port.list();
      setLoadedAt(nowFn());
      setState({ status: "ready", list });
    } catch (e) {
      setState(autoBuyFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const rows = state.status === "ready" ? buildRuleRows(state.list) : [];
  const clock = state.status === "ready" ? listClock(state.list, loadedAt) : null;

  const act = async (id: string, f: (key: string) => Promise<void>) => {
    if (busyId !== null) return;
    setBusyId(id);
    setFailed(false);
    const key = keys.current.get(id) ?? newIdempotencyKey();
    keys.current.set(id, key);
    try {
      await f(key);
      keys.current.delete(id);
      await load(true);
    } catch {
      setFailed(true);
    } finally {
      setBusyId(null);
    }
  };

  // Only an unattended charge has a pre-charge cancel window; notify-and-confirm never charges without the shopper.
  // The 1 s tick lives in a leaf <Ticker> per unattended attempt, so the screen is not re-rendered each second.
  const attemptBlock = (a: AutoBuyAttempt, mode: "notifyConfirm" | "unattended") =>
    mode === "unattended"
      ? <Ticker nowFn={nowFn} render={(n) => attemptView(a, mode, cancelWindow(a, clock, n))} />
      : attemptView(a, mode, { kind: "closed" } as const);
  const attemptView = (a: AutoBuyAttempt, mode: "notifyConfirm" | "unattended", w: ReturnType<typeof cancelWindow>) => {
    return (
      <View style={{ gap: 8, borderStartWidth: 2, borderStartColor: colors.hairline, paddingStart: 12 }}>
        <Eyebrow>{t(`autoBuy.attempt.state.${a.state}`)}</Eyebrow>
        {mode === "notifyConfirm" ? <Text variant="callout" secondary>{t("autoBuy.attempt.confirmYourself")}</Text> : null}
        {w.kind === "open" ? (
          <>
            <View accessible accessibilityLabel={t("autoBuy.attempt.remainingA11y", { m: num(w.parts.minutes), s: num(w.parts.seconds) })}>
              <Text variant="callout" accessibilityRole="none">
                {t("autoBuy.attempt.remaining", { time: `${num(w.parts.minutes)}:${localizeDigits(pad2(w.parts.seconds), locale)}` })}
              </Text>
            </View>
            <Text variant="caption" secondary>{t("autoBuy.attempt.chargeAfter", { time: formatCairoClock(w.deadlineMs, locale) })}</Text>
          </>
        ) : null}
        {w.kind === "deadline" ? <Text variant="callout">{t("autoBuy.attempt.deadline", { time: formatCairoClock(w.deadlineMs, locale) })}</Text> : null}
        {w.kind !== "closed" ? (
          <Button
            variant="secondary"
            title={t("autoBuy.attempt.cancel")}
            loading={busyId === a.id}
            disabled={busyId !== null}
            onPress={() => void act(a.id, (key) => port.cancelAttempt(a.id, key))}
          />
        ) : mode === "unattended" && (a.state === "NOTIFIED" || a.state === "TRIGGERED") ? (
          <Text variant="caption" secondary>{t("autoBuy.attempt.windowClosed")}</Text>
        ) : null}
        {a.failureReason !== null ? <Text variant="caption" color="danger">{t("autoBuy.attempt.failed")}</Text> : null}
      </View>
    );
  };

  const row = (r: RuleRowView, index: number) => {
    const rule = r.rule;
    return (
      <Reveal key={rule.id} index={index}>
        <View style={{ gap: 12, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="title2" numberOfLines={2}>{rule.title ?? t("autoBuy.untitled")}</Text>
              <Text variant="caption" secondary>{t("autoBuy.row.size", { size: rule.sizeLabel })}</Text>
            </View>
            <Badge label={t(`autoBuy.badge.${r.badge}`)} />
          </View>
          <View style={{ flexDirection: "row", gap: 24 }}>
            <View style={{ gap: 2 }}><Eyebrow>{t("autoBuy.row.target")}</Eyebrow><Text variant="headline" numeric>{money(rule.targetPrice)}</Text></View>
            <View style={{ gap: 2 }}><Eyebrow>{t("autoBuy.row.max")}</Eyebrow><Text variant="headline" numeric>{money(rule.maxPrice)}</Text></View>
          </View>
          <Text variant="caption" secondary>
            {t(rule.mode === "unattended" ? "autoBuy.row.modeUnattended" : "autoBuy.row.modeNotify")}
            {" · "}
            {t("autoBuy.row.expires", { date: formatCairoDate(rule.expiresAtMs, locale) })}
          </Text>
          {r.badge === "paused" ? <Text variant="caption" secondary>{t("autoBuy.row.pausedNote")}</Text> : null}
          {r.attention !== null ? attemptBlock(r.attention, rule.mode) : null}
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            {rule.productId !== null ? (
              <View style={{ flexGrow: 1 }}><Button variant="secondary" title={t("autoBuy.row.open")} onPress={() => { if (rule.productId !== null) props.onOpenProduct?.(rule.productId); }} /></View>
            ) : null}
            {r.canCancel ? (
              <View style={{ flexGrow: 1 }}>
                <Button variant="ghost" title={t("autoBuy.row.cancel")} loading={busyId === rule.id} disabled={busyId !== null} onPress={() => void act(rule.id, (key) => port.cancelRule(rule.id, key))} />
              </View>
            ) : null}
          </View>
        </View>
      </Reveal>
    );
  };

  return (
    <Screen title={t("autoBuy.title")} onBack={props.onBack} backLabel={t("common.back")} onRefresh={() => void load(true)}>
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("autoBuy.loading")} style={{ gap: 14 }}>
          <Skeleton height={20} width="50%" /><Skeleton height={64} radius={14} /><Skeleton height={64} radius={14} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "autoBuy.offlineTitle" : "autoBuy.errorTitle")}
          description={t(state.offline ? "autoBuy.offlineBody" : "autoBuy.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {state.status === "ready" ? (
        <>
          <Text variant="lede" secondary>{t("autoBuy.lede")}</Text>
          {state.list.paused ? <Banner tone="info" message={t("autoBuy.pausedBanner")} /> : null}
          {failed ? <Banner tone="error" message={t("autoBuy.actionFailed")} /> : null}
          {rows.length === 0 ? (
            <EmptyState
              illustration={<Illustration name="emptyWishlist" size={120} />}
              title={t("autoBuy.emptyTitle")}
              description={t("autoBuy.emptyBody")}
              {...(props.onBack !== undefined ? { actionTitle: t("common.back"), onAction: props.onBack } : {})}
            />
          ) : (
            <View>{rows.map((r, i) => row(r, i))}</View>
          )}
        </>
      ) : null}
    </Screen>
  );
}
