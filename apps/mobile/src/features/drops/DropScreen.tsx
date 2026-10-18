import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { Banner, Button, Divider, Eyebrow, FullBleedHero, Reveal, Screen, Skeleton, Text } from "../../ui";
import { HeroArt, type HeroVariant } from "../../art";
import { OfflineBanner, StateScreen } from "../../components/states";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { Ticker } from "../../components/Ticker";
import { holdAdmission } from "./admissionStore";
import { dropRenderKey } from "./tick";
import {
  canJoin, clockFromServer, countdownParts, dropFailureState, dropPhase, nextPollDelay, serverNow, stockLabelCount, tokenState, waitingView,
  type DropScreenState, type DropSnapshot, type DropsPort, type QueueStatus, type RejectReason, type ServerClock,
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

/** Module-level so the Reveal entrance does not replay on the 1 s countdown re-render. */
function Block(p: { children: ReactNode; index?: number }) {
  return <Reveal index={p.index ?? 0}><View style={{ gap: 12, paddingVertical: 8 }}>{p.children}</View></Reveal>;
}

export function DropScreen(props: { dropId: string; port?: DropsPort; now?: () => number; onEnter?: (dropId: string) => void; newKey?: () => string; guest?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<DropsPort>(() => props.port ?? getFeaturePorts().drops, [props.port]);
  const nowFn = props.now ?? Date.now;
  const counter = useRef(0);
  const newKey = props.newKey ?? (() => `drop-${Date.now()}-${(counter.current += 1)}`);
  const num = (n: number) => localizeDigits(String(n), locale);
  const guest = props.guest === true;

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

  // The screen re-renders only when the phase or token validity changes (see dropRenderKey). The 1 s
  // countdown digits are ticked by a leaf <Ticker>, so the rest of the screen is not re-rendered each second.
  const latest = useRef<{ drop: DropSnapshot | null; clock: ServerClock | null; queue: QueueStatus; admittedOffsetMs: number }>({
    drop: null, clock: null, queue: { state: "idle" }, admittedOffsetMs: 0,
  });
  useEffect(() => {
    const id = setInterval(() => {
      const n = nowFn();
      setTick((prev) => {
        const l = latest.current;
        return dropRenderKey({ ...l, nowMs: prev }) === dropRenderKey({ ...l, nowMs: n }) ? prev : n;
      });
    }, 1000);
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
  const targetMs = phase !== null && "untilMs" in phase ? nowSrv + phase.untilMs : 0;

  // Server clock for the admitted token comes from the status response, then advances locally.
  const admittedClockRef = useRef<{ offsetMs: number } | null>(null);
  if (queue.state === "admitted" && admittedClockRef.current === null) {
    admittedClockRef.current = { offsetMs: queue.serverNowMs - nowFn() };
  }
  if (queue.state !== "admitted") admittedClockRef.current = null;
  const token = queue.state === "admitted" ? tokenState(queue.token, tick + (admittedClockRef.current?.offsetMs ?? 0)) : null;
  const tokenExpired = token?.kind === "expired";
  latest.current = { drop: ready?.drop ?? null, clock: ready?.clock ?? null, queue, admittedOffsetMs: admittedClockRef.current?.offsetMs ?? 0 };

  const enter = () => {
    if (queue.state !== "admitted") return;
    holdAdmission(props.dropId, queue.token);
    props.onEnter?.(props.dropId);
  };

  const parts = (ms: number) => countdownParts(ms);
  const segments = (ms: number) => {
    const p = parts(ms);
    const two = (n: number) => num(Math.min(99, n)).padStart(2, locale === "ar" ? "٠" : "0");
    const out: { key: string; value: string; unit: string }[] = [];
    if (p.days > 0) out.push({ key: "d", value: two(p.days), unit: t("drops.unitDays") });
    out.push({ key: "h", value: two(p.hours), unit: t("drops.unitHours") });
    out.push({ key: "m", value: two(p.minutes), unit: t("drops.unitMinutes") });
    out.push({ key: "s", value: two(p.seconds), unit: t("drops.unitSeconds") });
    return out;
  };
  const countdownName = (ms: number) => {
    const p = parts(ms);
    return t("drops.countdownName", { days: num(p.days), hours: num(p.hours), minutes: num(p.minutes), seconds: num(p.seconds) });
  };

  const heroVariant: HeroVariant = ready?.drop.type === "members" ? "plus" : ready?.drop.type === "lastChance" ? "sale" : "drop";

  const router = useRouter();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)" as Href));
  return (
    <Screen onBack={goBack} backLabel={t("common.back")}>
      <OfflineBanner visible={state.status === "error" && state.offline} message={t("common.offlineBanner")} />
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("drops.loading")} style={{ gap: 14 }}>
          <Skeleton height={380} radius={20} />
          <Skeleton width="40%" height={12} />
          <Skeleton width="85%" height={56} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <StateScreen
          illustration={state.offline ? "offline" : "error"}
          title={t(state.offline ? "drops.offlineTitle" : "drops.errorTitle")}
          description={t(state.offline ? "drops.offlineBody" : "drops.errorBody")}
          actionTitle={t("common.retry")}
          onAction={() => void load()}
        />
      ) : null}
      {state.status === "notFound" ? <StateScreen illustration="noResults" title={t("drops.notFoundTitle")} description={t("drops.notFoundBody")} /> : null}

      {ready !== null && phase !== null ? (
        <>
          <FullBleedHero
            imageNode={<HeroArt variant={heroVariant} style={{ width: "100%", height: "100%", aspectRatio: undefined }} />}
            aspectRatio={0.9}
            cornerRadius={20}
            bleed={false}
            eyebrow={`${ready.drop.storeName} · ${t(`drops.type.${ready.drop.type}`)}`}
            title={ready.drop.title}
          />
          <Block index={1}>
            {phase.kind === "upcoming" || phase.kind === "earlyAccess" || phase.kind === "live" ? (
              <>
                <Eyebrow>{t(phase.kind === "upcoming" ? "drops.phaseUpcoming" : phase.kind === "earlyAccess" ? "drops.phaseEarlyAccess" : "drops.phaseLive")}</Eyebrow>
                <Ticker
                  nowFn={nowFn}
                  render={(n) => {
                    const until = Math.max(0, targetMs - serverNow(ready.clock, n));
                    return (
                    <View accessible accessibilityRole="timer" accessibilityLabel={countdownName(until)} testID="drop-countdown" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                      {segments(until).map((sg, i) => (
                        <View key={sg.key} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                          {i > 0 ? <Text variant="hero" color="textSecondary" accessibilityRole="none" style={{ fontWeight: "300" }}>:</Text> : null}
                          <View style={{ alignItems: "center", gap: 2 }}>
                            <Text variant="hero" numeric accessibilityRole="none">{sg.value}</Text>
                            <Text variant="eyebrow" secondary accessibilityRole="none">{sg.unit}</Text>
                          </View>
                        </View>
                      ))}
                    </View>
                    );
                  }}
                />
                <Text variant="caption" secondary>{t("drops.clockNote")}</Text>
              </>
            ) : null}
            {phase.kind === "soldOut" ? <Banner tone="warning" message={t("drops.phaseSoldOut")} /> : null}
            {phase.kind === "ended" ? <Banner tone="info" message={t("drops.phaseEnded")} /> : null}
            {phase.kind === "paused" ? <Banner tone="warning" message={t("drops.phasePaused")} /> : null}
            <Divider />
            <Text variant="caption" secondary>{t("drops.limit", { count: num(ready.drop.perUserLimit) })}</Text>
            {stockLabelCount(ready.drop) !== null ? <Text variant="caption">{t("drops.stockLow", { count: num(stockLabelCount(ready.drop) ?? 0) })}</Text> : null}
          </Block>

          {queue.state === "waiting" ? (
            <Block index={2}>
              <Eyebrow>{t("drops.waitingTitle")}</Eyebrow>
              {(() => {
                const w = waitingView(queue);
                return (
                  <>
                    {w.position !== null ? <Text variant="display" numeric>{t("drops.waitingPosition", { position: num(w.position) })}</Text> : null}
                    {w.etaMinutes !== null ? <Text>{t("drops.waitingEta", { minutes: num(w.etaMinutes) })}</Text> : null}
                    {w.position === null && w.etaMinutes === null ? <Text secondary>{t("drops.waitingNoEstimate")}</Text> : null}
                  </>
                );
              })()}
              <Text variant="caption" secondary>{t("drops.waitingKeepOpen")}</Text>
              <Skeleton height={4} radius={2} />
              <Button variant="secondary" title={t("drops.leave")} onPress={() => void leave()} />
            </Block>
          ) : null}

          {queue.state === "admitted" && token !== null && token.kind === "valid" ? (
            <Block index={2}>
              <Eyebrow>{t("drops.admittedTitle")}</Eyebrow>
              <Text>{t("drops.admittedBody", { minutes: num(Math.max(1, Math.ceil(token.remainingMs / 60_000))) })}</Text>
              <Button variant="brand" title={t("drops.enter")} onPress={enter} />
            </Block>
          ) : null}

          {queue.state === "expired" || tokenExpired ? (
            <Banner tone="warning" message={`${t("drops.tokenExpiredTitle")}. ${t("drops.tokenExpiredBody")}`} />
          ) : null}

          {queue.state === "rejected" ? <Banner tone="warning" message={t(REJECT_KEY[queue.reason])} /> : null}
          {joinFailed ? <Banner tone="error" message={t("drops.joinFailed")} /> : null}
          {waitlisted ? <Banner tone="info" message={t("drops.waitlistDone")} /> : null}

          {guest ? <Banner tone="info" message={t("guestMe.dropsNoBuy")} /> : null}
          {!guest && canJoin(phase, tokenExpired ? { state: "expired" } : queue) ? (
            <Button variant="brand" title={t(busy ? "drops.joining" : "drops.join")} loading={busy} disabled={busy} onPress={() => void join()} />
          ) : null}
          {!guest && phase.kind === "soldOut" && !waitlisted ? <Button variant="secondary" title={t("drops.waitlist")} onPress={() => void waitlist()} /> : null}
        </>
      ) : null}
    </Screen>
  );
}
