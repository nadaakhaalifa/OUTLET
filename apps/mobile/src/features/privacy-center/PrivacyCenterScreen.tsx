import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Button, Checkbox, Divider, ErrorState, Reveal, Screen, Skeleton, SwitchRow, Text } from "../../ui";
import { SectionHead } from "../account-ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { formatDay } from "../orders/model";
import { uuidv7 } from "../checkout/model";
import {
  applyConsent, canRequestDeletion, cancellable, orderedBlockers, privacyFailureState, sortSessions,
  type PrivacyPort, type PrivacyScreenState, type PrivacySnapshot,
} from "./model";
import { TestId } from "../../components/TestId";
import { getFeaturePorts } from "../../state/ports";

const blockerTestId = { open_orders: "orders", open_returns: "returns", open_disputes: "disputes" } as const;

function newKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

export function PrivacyCenterScreen(props: { port?: PrivacyPort }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<PrivacyPort>(() => props.port ?? getFeaturePorts().privacy, [props.port]);
  const [state, setState] = useState<PrivacyScreenState>({ status: "loading" });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const inFlight = useRef(false);
  const day = (iso: string) => formatDay(iso, (s) => localizeDigits(s, locale));

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(privacyFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const patch = (p: Partial<PrivacySnapshot>) => setState((s) => (s.status === "ready" ? { status: "ready", snapshot: { ...s.snapshot, ...p } } : s));

  const toggle = async (purpose: string, granted: boolean) => {
    // Applied to the screen first: withdrawal is one tap and never waits for the network.
    if (state.status === "ready") patch({ consents: applyConsent(state.snapshot.consents, purpose, granted) });
    try {
      await port.setConsent(purpose, granted);
    } catch {
      setMessage({ tone: "error", text: t("privacyCenter.actionFailed") });
    }
  };

  const run = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch {
      setMessage({ tone: "error", text: t("privacyCenter.actionFailed") });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const snap = state.status === "ready" ? state.snapshot : null;
  const del = snap?.deletion ?? null;
  const blockers = del !== null ? orderedBlockers(del) : [];
  const blockerKey = { open_orders: "privacyCenter.blockerOrders", open_returns: "privacyCenter.blockerReturns", open_disputes: "privacyCenter.blockerDisputes" } as const;

  return (
    <Screen title={t("privacyCenter.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Reveal index={0}><Text variant="lede" secondary>{t("privacyCenter.intro")}</Text></Reveal>
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("privacyCenter.loading")} style={{ gap: 14 }}>
          <Skeleton width="45%" height={28} />
          <Skeleton height={48} radius={14} />
          <Skeleton height={48} radius={14} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState offline={state.offline} title={t(state.offline ? "privacyCenter.offlineTitle" : "privacyCenter.errorTitle")}
          description={t(state.offline ? "privacyCenter.offlineBody" : "privacyCenter.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
      ) : null}
      {message !== null ? <Banner tone={message.tone} message={message.text} /> : null}
      {snap !== null && del !== null ? (
        <>
          <SectionHead first index={1} title={t("privacyCenter.consentsHeading")} />
          <Text variant="caption" secondary>{t("privacyCenter.consentsHint")}</Text>
          {snap.consents.map((c) => (
            <View key={c.purpose}>
              <SwitchRow label={t(`consent.purposes.${c.purpose}.title`)} value={c.granted} onValueChange={(v) => void toggle(c.purpose, v)} />
              <Text variant="caption" secondary style={{ paddingBottom: 12 }}>{t(`consent.purposes.${c.purpose}.description`)}</Text>
              <Divider />
            </View>
          ))}
          {snap.pendingSync > 0 ? <Banner tone="info" message={t("privacyCenter.syncPending", { count: localizeDigits(String(snap.pendingSync), locale) })} /> : null}

          <SectionHead index={2} title={t("privacyCenter.exportHeading")} />
          <Text secondary>{t("privacyCenter.exportBody")}</Text>
          {snap.export.state === "none" ? <Text variant="caption" secondary>{t("privacyCenter.exportNone")}</Text> : null}
          {snap.export.state === "requested" ? <Banner tone="info" message={t("privacyCenter.exportRequested", { date: day(snap.export.dueAt) })} /> : null}
          {snap.export.state === "ready" ? (
            <>
              <Banner tone="info" message={t("privacyCenter.exportReady", { date: day(snap.export.expiresAt) })} />
              {snap.export.url !== null && snap.export.url.startsWith("https://") ? (
                <Button variant="secondary" title={t("privacyCenter.exportDownload")} onPress={() => { const u = snap.export.state === "ready" ? snap.export.url : null; if (u !== null) void Linking.openURL(u); }} />
              ) : null}
            </>
          ) : null}
          <Button variant="secondary" title={t("privacyCenter.exportRequest")} disabled={busy || snap.export.state === "requested"}
            onPress={() => void run(async () => patch({ export: await port.requestExport(newKey()) }))} />

          <SectionHead index={3} title={t("privacyCenter.deleteHeading")} />
          <Text secondary>{t("privacyCenter.deleteIntro")}</Text>
          <Text secondary>{t("privacyCenter.deleteCooling", { days: localizeDigits(String(del.state === "eligible" ? del.coolingDays : 14), locale) })}</Text>
          <Text secondary>{t("privacyCenter.deleteLegal")}</Text>
          {del.state === "blocked" ? (
            <>
              <Banner tone="warning" message={t("privacyCenter.deleteBlockedHeading")} />
              {blockers.map((b) => (
                <TestId key={b.kind} id={`privacy-delete-blocker-${blockerTestId[b.kind]}`}>
                  <Banner tone="warning" message={t(blockerKey[b.kind], { count: localizeDigits(String(b.count), locale) })} />
                </TestId>
              ))}
            </>
          ) : null}
          {del.state === "cooling" ? <Banner tone="warning" message={t("privacyCenter.deleteRequested", { date: day(del.endsAt) })} /> : null}
          {del.state === "eligible" && del.forfeiture !== null ? (
            <>
              <Banner tone="warning" message={t("privacyCenter.forfeiture", { amount: formatMoney(del.forfeiture, locale, t("common.currency")) })} />
              <Checkbox label={t("privacyCenter.acknowledge")} value={ack} onValueChange={setAck} />
            </>
          ) : null}
          {del.state !== "cooling" ? (
            <Button variant="destructive" title={t("privacyCenter.deleteButton")} disabled={busy || !canRequestDeletion(del, ack)}
              onPress={() => void run(async () => patch({ deletion: await port.requestDeletion({ acknowledgedForfeiture: ack, idempotencyKey: newKey() }) }))} />
          ) : null}
          {cancellable(del) ? (
            <Button variant="secondary" title={t("privacyCenter.deleteCancel")} disabled={busy}
              onPress={() => void run(async () => { patch({ deletion: await port.cancelDeletion() }); setMessage({ tone: "info", text: t("privacyCenter.deleteCancelled") }); })} />
          ) : null}

          <SectionHead index={4} title={t("privacyCenter.sessionsHeading")} />
          {snap.sessions.length === 0 ? <Text variant="caption" secondary>{t("privacyCenter.sessionsEmpty")}</Text> : null}
          {sortSessions(snap.sessions).map((s) => (
            <View key={s.id} style={{ gap: 6 }}>
              <Text>{s.deviceLabel}</Text>
              <View style={{ gap: 2 }}>
                {s.current ? <Text variant="caption" secondary>{t("privacyCenter.sessionCurrent")}</Text> : null}
                <Text variant="caption" secondary>{t("privacyCenter.sessionLastUsed", { date: day(s.lastUsedAt) })}</Text>
              </View>
              {!s.current && port.revokeSession !== undefined ? (
                <Button variant="secondary" disabled={busy} title={t("privacyCenter.sessionRevoke")} accessibilityLabel={t("privacyCenter.sessionRevokeName", { device: s.deviceLabel })}
                  onPress={() => void run(async () => { await port.revokeSession?.(s.id); patch({ sessions: snap.sessions.filter((x) => x.id !== s.id) }); })} />
              ) : null}
              <Divider />
            </View>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
