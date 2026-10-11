import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, ErrorState, LoadingState, Screen, Text } from "../../ui";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { Choice } from "../checkout/Choice";
import { pickText, uuidv7 } from "../checkout/model";
import { formatDay } from "../orders/model";
import {
  EMPTY_DRAFT, MAX_PHOTOS, RETURN_REASONS, addPhoto, buildReturnRequest, flowBlockers,
  photosRequired, removePhoto, resolutionOptions, returnsFailureState, setReason, windowFor,
  type FlowDraft, type PhotoPickerPort, type ReturnMethod, type ReturnsPort, type ReturnsScreenState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

function newKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

export function ReturnsScreen(props: { orderLineId: string; port?: ReturnsPort; photos?: PhotoPickerPort; nowMs?: () => number }) {
  const { t, i18n } = useTranslation();
  const lang: "ar" | "en" = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<ReturnsPort>(() => props.port ?? getFeaturePorts().returns, [props.port]);
  const picker = useMemo<PhotoPickerPort>(() => props.photos ?? getFeaturePorts().photos, [props.photos]);
  const [state, setState] = useState<ReturnsScreenState>({ status: "loading" });
  const [draft, setDraft] = useState<FlowDraft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const [result, setResult] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);
  const day = (iso: string) => formatDay(iso, (s) => localizeDigits(s, locale));

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", candidate: await port.load(props.orderLineId) });
    } catch (e) {
      setState(returnsFailureState(e));
    }
  }, [port, props.orderLineId]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (state.status !== "ready" || inFlight.current) return;
    const e = state.candidate.eligibility;
    const now = (props.nowMs ?? Date.now)();
    setShowErrors(true);
    if (flowBlockers(draft, e, now).length > 0) return;
    const req = buildReturnRequest(state.candidate.orderLineId, draft, e);
    if (req === null) return;
    inFlight.current = true;
    setSending(true);
    setResult(null);
    try {
      key.current ??= newKey();
      const r = await port.submit(req, key.current);
      if (r.ok) setDone(true);
      else {
        key.current = null;
        setResult({ tone: "error", text: t("returns.rejected", { reason: pickText(r.reason, lang) }) });
      }
    } catch {
      // Same key is kept so a retry after a network drop cannot create a second return.
      setResult({ tone: "error", text: t("returns.failed") });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <Text variant="title">{t("returns.title")}</Text>
        <Banner tone="info" message={t("returns.submitted")} />
      </Screen>
    );
  }

  const cand = state.status === "ready" ? state.candidate : null;
  const e = cand?.eligibility ?? null;
  const now = (props.nowMs ?? Date.now)();
  const win = e !== null && draft.reason !== null ? windowFor(draft.reason, e, now) : null;
  const blockers = e !== null ? flowBlockers(draft, e, now) : [];
  const options = e !== null ? resolutionOptions(draft.reason, e) : [];

  return (
    <Screen>
      <Text variant="title">{t("returns.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("returns.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState offline={state.offline} title={t(state.offline ? "returns.offlineTitle" : "returns.errorTitle")}
          description={t(state.offline ? "returns.offlineBody" : "returns.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
      ) : null}
      {cand !== null && e !== null ? (
        <>
          <Card>
            <Text variant="heading">{t("returns.item", { title: cand.title, store: cand.storeName })}</Text>
            <Text secondary>{t("returns.windowDelivered", { date: day(e.deliveredAt) })}</Text>
            {!e.eligible ? <Banner tone="error" prefix={t("returns.notEligible")} message={e.message !== null ? pickText(e.message, lang) : t("returns.blockers.notEligible")} /> : null}
            {e.eligible && e.message !== null ? <Banner tone="info" message={pickText(e.message, lang)} /> : null}
            {win !== null ? (
              win.open ? (
                <Text secondary>{t("returns.windowOpen", { days: localizeDigits(String(win.days), locale), left: localizeDigits(String(win.daysLeft), locale), until: day(new Date(win.endsAtMs).toISOString()) })}</Text>
              ) : (
                <Banner tone="warning" message={t("returns.windowClosed", { until: day(new Date(win.endsAtMs).toISOString()) })} />
              )
            ) : null}
            <Text variant="caption" secondary>{t(`returns.shippingPaid.${e.returnShippingPaidBy}`)}</Text>
          </Card>

          {e.eligible ? (
            <>
              <Card>
                <Text variant="heading">{t("returns.reasonHeading")}</Text>
                <View accessibilityRole="radiogroup" style={{ gap: spacing.xs }}>
                  {RETURN_REASONS.map((r) => (
                    <Choice key={r} testID={`returns-reason-${r}`} label={t(`returns.reason.${r}`)} selected={draft.reason === r} onPress={() => setDraft(setReason(draft, r, e))} />
                  ))}
                </View>
                {showErrors && blockers.includes("reason") ? <Banner tone="error" message={t("returns.blockers.reason")} /> : null}
              </Card>

              {draft.reason !== null ? (
                <>
                  <Card>
                    <Text variant="heading">{t("returns.photosHeading")}</Text>
                    <Text secondary>{t(photosRequired(draft.reason) ? "returns.photosRequired" : "returns.photosOptional")}</Text>
                    <Text variant="caption" secondary>{t("returns.photoCount", { count: localizeDigits(String(draft.photos.length), locale), max: localizeDigits(String(MAX_PHOTOS), locale) })}</Text>
                    {draft.photos.map((p, i) => (
                      <Button key={p.uri} variant="secondary" title={t("returns.removePhoto", { n: localizeDigits(String(i + 1), locale) })} onPress={() => setDraft(removePhoto(draft, p.uri))} />
                    ))}
                    {draft.photos.length < MAX_PHOTOS ? (
                      <Button variant="secondary" title={t("returns.addPhoto")} onPress={() => void picker.pick().then((p) => { if (p !== null) setDraft((d) => addPhoto(d, p)); })} />
                    ) : null}
                    {showErrors && blockers.includes("photos") ? <Banner tone="error" message={t("returns.blockers.photos")} /> : null}
                  </Card>

                  <Card>
                    <Text variant="heading">{t("returns.resolutionHeading")}</Text>
                    <View accessibilityRole="radiogroup" style={{ gap: spacing.xs }}>
                      {options.map((o) => (
                        <Choice key={o} label={t(`returns.${o}`)} selected={draft.resolution === o}
                          detail={o === "exchange" ? <Text variant="caption" secondary>{t("returns.exchangeNote")}</Text> : undefined}
                          onPress={() => setDraft({ ...draft, resolution: o, refundTarget: null })} />
                      ))}
                    </View>
                    {draft.resolution === "refund" && e.allowedRefundTargets.length > 1 ? (
                      <>
                        <Text variant="caption" secondary>{t("returns.refundTargetHeading")}</Text>
                        <View accessibilityRole="radiogroup" style={{ gap: spacing.xs }}>
                          {e.allowedRefundTargets.map((rt) => (
                            <Choice key={rt} label={t(`returns.refundTarget.${rt}`)} selected={draft.refundTarget === rt} onPress={() => setDraft({ ...draft, refundTarget: rt })} />
                          ))}
                        </View>
                        {showErrors && blockers.includes("refundTarget") ? <Banner tone="error" message={t("returns.blockers.refundTarget")} /> : null}
                      </>
                    ) : null}
                  </Card>

                  <Card>
                    <Text variant="heading">{t("returns.methodHeading")}</Text>
                    <View accessibilityRole="radiogroup" style={{ gap: spacing.xs }}>
                      {(["pickup", "dropoff"] as const satisfies readonly ReturnMethod[]).map((m) => (
                        <Choice key={m} label={t(`returns.method.${m}`)} selected={draft.method === m} onPress={() => setDraft({ ...draft, method: m })} />
                      ))}
                    </View>
                  </Card>
                </>
              ) : null}

              {showErrors && blockers.includes("window") ? <Banner tone="error" message={t("returns.blockers.window")} /> : null}
              {result !== null ? <Banner tone={result.tone} message={result.text} /> : null}
              <Button title={t(sending ? "returns.submitting" : "returns.submit")} loading={sending} disabled={sending} onPress={() => void submit()} />
            </>
          ) : null}
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
