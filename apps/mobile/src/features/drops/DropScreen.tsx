import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from "../../ui";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { holdAdmission } from "./admissionStore";
import {
  canJoin, clockFromServer, countdownParts, dropFailureState, dropPhase, nextPollDelay, serverNow, stockLabelCount, tokenState, waitingView,
  type DropScreenState, type DropsPort, type QueueStatus, type RejectReason,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

const REJECT_KEY: Readonly<Record<RejectReason, string>> = {
  perUserLimit: "drops.rejectPerUser",
  membersOnly: "drops.rejectMembers",
  soldOut: "drops.rejectSoldOut",
  notLive: "drops.rejectNotLive",
  paused: "drops.rejectPaused",
  underAge: "drops.rejectAge",
};

export function DropScreen(props: { dropId: string; port?: DropsPort; now?: () => number; onEnter?: (dropId: string) => void; newKey?: () => string }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<DropsPort>(() => props.port ?? getFeaturePorts().drops, [props.port]);
  const nowFn = props.now ?? Date.now;
  const counter = useRef(0);
  const newKey = props.newKey ?? (() => `drop-${Date.now()}-${(counter.current += 1)}`);
  const num = (n: number) => localizeDigits(String(n), locale);

  const [state, setState] = useState<DropScreenState>({ status: "loading" });
  const [queue, setQueue] = useState<QueueStatus>({ state: "idle" });
  const [tick, setTick] = useState(() => nowFn());
  const [busy, setBusy] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const [waitlisted, setWaitlisted] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const drop = await port.getDrop(props.dropId);
      setState(drop === null ? { status: "notFound" } : { status: "ready", drop, clock: clockFromServer(drop.serverNowMs, nowFn()) });
    } catch (e) {
      setState(dropFailureState(e));
    }
  }, [port, props.dropId]);
  useEffect(() => { void load(); }, [load]);

  // One-second tick drives the countdown from the server-anchored offset (no animation).
  useEffect(() => {
    const id = setInterval(() => setTick(nowFn()), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll queue status only while waiting, at the server's cadence (never faster than 1/s).
  const waiting = queue.state === "waiting" ? queue : null;
  useEffect(() => {
    if (waiting === null) return;
    let alive = true;
    const id = setTimeout(() => {
      port.status(props.dropId).then(
        (s) => { if (alive) setQueue(s); },
        () => { /* keep the last server answer; the next poll retries */ },
      );
    }, nextPollDelay(waiting));
    return () => { alive = false; clearTimeout(id); };
  }, [port, props.dropId, waiting]);

  const join = async () => {
    setBusy(true);
    setJoinFailed(false);
    try {
      setQueue(await port.join(props.dropId, newKey()));
    } catch {
      setJoinFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    try { await port.leave(props.dropId); } catch { /* the heartbeat TTL releases the slot */ }
    setQueue({ state: "idle" });
  };
  const waitlist = async () => {
    try { await port.waitlist(props.dropId, newKey()); setWaitlisted(true); } catch { setJoinFailed(true); }
  };

  const ready = state.status === "ready" ? state : null;
  const nowSrv = ready !== null ? serverNow(ready.clock, tick) : 0;
  const phase = ready !== null ? dropPhase(ready.drop, nowSrv) : null;

  // Server clock for the admitted token comes from the status response, then advances locally.
  const admittedClockRef = useRef<{ offsetMs: number } | null>(null);
  if (queue.state === "admitted" && admittedClockRef.current === null) {
    admittedClockRef.current = { offsetMs: queue.serverNowMs - nowFn() };
  }
  if (queue.state !== "admitted") admittedClockRef.current = null;
  const token = queue.state === "admitted" ? tokenState(queue.token, tick + (admittedClockRef.current?.offsetMs ?? 0)) : null;
  const tokenExpired = token?.kind === "expired";

  const enter = () => {
    if (queue.state !== "admitted") return;
    holdAdmission(props.dropId, queue.token);
    props.onEnter?.(props.dropId);
  };

  const parts = (ms: number) => countdownParts(ms);
  const countdownText = (ms: number) => {
    const p = parts(ms);
    return t("drops.countdown", { days: num(p.days), hours: num(p.hours), minutes: num(p.minutes), seconds: num(p.seconds) });
  };
  const countdownName = (ms: number) => {
    const p = parts(ms);
    return t("drops.countdownName", { days: num(p.days), hours: num(p.hours), minutes: num(p.minutes), seconds: num(p.seconds) });
  };

  return (
    <Screen>
      <Text variant="title">{ready !== null ? ready.drop.title : t("drops.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("drops.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "drops.offlineTitle" : "drops.errorTitle")}
          description={t(state.offline ? "drops.offlineBody" : "drops.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {state.status === "notFound" ? <EmptyState title={t("drops.notFoundTitle")} description={t("drops.notFoundBody")} /> : null}

      {ready !== null && phase !== null ? (
        <>
          <Card>
            <Text secondary>{t("drops.store", { store: ready.drop.storeName })}</Text>
            <Text variant="caption" secondary>{t(`drops.type.${ready.drop.type}`)}</Text>
            {phase.kind === "upcoming" || phase.kind === "earlyAccess" || phase.kind === "live" ? (
              <>
                <Text>{t(phase.kind === "upcoming" ? "drops.phaseUpcoming" : phase.kind === "earlyAccess" ? "drops.phaseEarlyAccess" : "drops.phaseLive")}</Text>
                <Text variant="heading" accessibilityRole="text">{countdownText(phase.untilMs)}</Text>
                <Text variant="caption" secondary>{countdownName(phase.untilMs)}</Text>
                <Text variant="caption" secondary>{t("drops.clockNote")}</Text>
              </>
            ) : null}
            {phase.kind === "soldOut" ? <Banner tone="warning" message={t("drops.phaseSoldOut")} /> : null}
            {phase.kind === "ended" ? <Banner tone="info" message={t("drops.phaseEnded")} /> : null}
            {phase.kind === "paused" ? <Banner tone="warning" message={t("drops.phasePaused")} /> : null}
            <Text variant="caption" secondary>{t("drops.limit", { count: num(ready.drop.perUserLimit) })}</Text>
            {stockLabelCount(ready.drop) !== null ? <Text variant="caption">{t("drops.stockLow", { count: num(stockLabelCount(ready.drop) ?? 0) })}</Text> : null}
          </Card>

          {queue.state === "waiting" ? (
            <Card>
              <Text variant="heading">{t("drops.waitingTitle")}</Text>
              {(() => {
                const w = waitingView(queue);
                return (
                  <>
                    {w.position !== null ? <Text>{t("drops.waitingPosition", { position: num(w.position) })}</Text> : null}
                    {w.etaMinutes !== null ? <Text>{t("drops.waitingEta", { minutes: num(w.etaMinutes) })}</Text> : null}
                    {w.position === null && w.etaMinutes === null ? <Text secondary>{t("drops.waitingNoEstimate")}</Text> : null}
                  </>
                );
              })()}
              <Text variant="caption" secondary>{t("drops.waitingKeepOpen")}</Text>
              <LoadingState label={t("drops.waitingTitle")} />
              <Button variant="secondary" title={t("drops.leave")} onPress={() => void leave()} />
            </Card>
          ) : null}

          {queue.state === "admitted" && token !== null && token.kind === "valid" ? (
            <Card>
              <Text variant="heading">{t("drops.admittedTitle")}</Text>
              <Text>{t("drops.admittedBody", { minutes: num(Math.max(1, Math.ceil(token.remainingMs / 60_000))) })}</Text>
              <Button title={t("drops.enter")} onPress={enter} />
            </Card>
          ) : null}

          {queue.state === "expired" || tokenExpired ? (
            <Banner tone="warning" message={`${t("drops.tokenExpiredTitle")}. ${t("drops.tokenExpiredBody")}`} />
          ) : null}

          {queue.state === "rejected" ? <Banner tone="warning" message={t(REJECT_KEY[queue.reason])} /> : null}
          {joinFailed ? <Banner tone="error" message={t("drops.joinFailed")} /> : null}
          {waitlisted ? <Banner tone="info" message={t("drops.waitlistDone")} /> : null}

          {canJoin(phase, tokenExpired ? { state: "expired" } : queue) ? (
            <Button title={t(busy ? "drops.joining" : "drops.join")} loading={busy} disabled={busy} onPress={() => void join()} />
          ) : null}
          {phase.kind === "soldOut" && !waitlisted ? <Button variant="secondary" title={t("drops.waitlist")} onPress={() => void waitlist()} /> : null}
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
