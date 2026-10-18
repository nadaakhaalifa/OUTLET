import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, ErrorState, Eyebrow, Icon, LoadingState, PressScale, Screen, StickyBar, Text, successNotice, useTheme } from "../../ui";
import { Illustration } from "../../art";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { Choice } from "../checkout/Choice";
import { pickText, uuidv7 } from "../checkout/model";
import { formatDay } from "../orders/model";
import { ItemArt } from "../purchase/ItemArt";
import { Section } from "../purchase/Section";
import { Flow, Settle } from "../purchase/motion";
import {
  EMPTY_DRAFT, MAX_PHOTOS, RETURN_REASONS, addPhoto, buildReturnRequest, flowBlockers, photosRequired, readyUploadIds, removePhoto,
  resolutionOptions, returnsFailureState, setReason, uploadBlockers, windowFor,
  type FlowDraft, type PhotoPickerPort, type PhotoUploadPort, type ReturnMethod, type ReturnsPort, type ReturnsScreenState, type UploadMap,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

function newKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

const TILE = 88;

export function ReturnsScreen(props: {
  orderLineId: string; port?: ReturnsPort; photos?: PhotoPickerPort; uploads?: PhotoUploadPort; nowMs?: () => number;
  onViewOrders?: () => void; onBack?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const lang: "ar" | "en" = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<ReturnsPort>(() => props.port ?? getFeaturePorts().returns, [props.port]);
  const picker = useMemo<PhotoPickerPort>(() => props.photos ?? getFeaturePorts().photos, [props.photos]);
  const uploader = useMemo<PhotoUploadPort>(() => props.uploads ?? getFeaturePorts().photoUploads, [props.uploads]);
  const [state, setState] = useState<ReturnsScreenState>({ status: "loading" });
  const [draft, setDraft] = useState<FlowDraft>(EMPTY_DRAFT);
  const [uploads, setUploads] = useState<UploadMap>({});
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

  const startUpload = useCallback((uri: string) => {
    setUploads((u) => ({ ...u, [uri]: { state: "uploading" } }));
    uploader.upload(uri).then(
      (r) => setUploads((u) => ({ ...u, [uri]: { state: "ready", uploadId: r.uploadId } })),
      () => setUploads((u) => ({ ...u, [uri]: { state: "failed" } })),
    );
  }, [uploader]);

  const addOne = () => {
    void picker.pick().then((p) => {
      if (p === null) return;
      setDraft((d) => addPhoto(d, p));
      startUpload(p.uri);
    });
  };

  const submit = async () => {
    if (state.status !== "ready" || inFlight.current) return;
    const e = state.candidate.eligibility;
    const now = (props.nowMs ?? Date.now)();
    setShowErrors(true);
    if (flowBlockers(draft, e, now).length > 0 || uploadBlockers(draft.photos, uploads).length > 0) return;
    const base = buildReturnRequest(state.candidate.orderLineId, draft, e);
    if (base === null) return;
    const ids = readyUploadIds(draft.photos, uploads);
    const req = ids.length > 0 ? { ...base, photoUploadIds: ids } : base;
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

  // One success haptic when the return is submitted.
  useEffect(() => { if (done) successNotice(); }, [done]);

  if (done) {
    return (
      <Screen>
        <View style={{ alignItems: "center", gap: spacing.lg, paddingTop: spacing.xxxl }}>
          <Settle><Illustration name="returnBox" size={128} label={t("returns.title")} /></Settle>
          <Settle delay={240} style={{ alignItems: "center", gap: spacing.lg }}>
            <Eyebrow>{t("returns.title")}</Eyebrow>
            <Text variant="display" align="center">{t("returns.doneTitle")}</Text>
            <Text variant="callout" secondary align="center">{t("returns.submitted")}</Text>
          </Settle>
        </View>
        {props.onViewOrders !== undefined ? <Settle delay={600}><Button title={t("checkout.viewOrders")} fullWidth onPress={props.onViewOrders} /></Settle> : null}
      </Screen>
    );
  }

  const cand = state.status === "ready" ? state.candidate : null;
  const e = cand?.eligibility ?? null;
  const now = (props.nowMs ?? Date.now)();
  const win = e !== null && draft.reason !== null ? windowFor(draft.reason, e, now) : null;
  const blockers = e !== null ? flowBlockers(draft, e, now) : [];
  const upBlockers = uploadBlockers(draft.photos, uploads);
  const options = e !== null ? resolutionOptions(draft.reason, e) : [];

  const footer = e !== null && e.eligible ? (
    <StickyBar>
      {result !== null ? <Text variant="caption" color={result.tone === "error" ? "danger" : "textSecondary"}>{result.text}</Text> : null}
      {showErrors && blockers.length > 0 ? <Text variant="caption" color="danger">{t(`returns.blockers.${blockers[0] ?? "notEligible"}`)}</Text> : null}
      {showErrors && upBlockers.length > 0 ? <Text variant="caption" color="danger">{t(`returns.${upBlockers[0] ?? "uploading"}`)}</Text> : null}
      <Button title={t(sending ? "returns.submitting" : "returns.submit")} fullWidth loading={sending} disabled={sending} onPress={() => void submit()} />
    </StickyBar>
  ) : undefined;

  return (
    <Screen title={t("returns.title")} {...(props.onBack !== undefined ? { onBack: props.onBack } : {})} {...(footer !== undefined ? { footer } : {})}>
      {state.status === "loading" ? <LoadingState label={t("returns.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState offline={state.offline} title={t(state.offline ? "returns.offlineTitle" : "returns.errorTitle")}
          description={t(state.offline ? "returns.offlineBody" : "returns.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
      ) : null}
      {cand !== null && e !== null ? (
        <>
          <View style={{ flexDirection: "row", gap: spacing.lg, alignItems: "center" }}>
            <ItemArt title={cand.title} seed={cand.orderLineId} width={72} label={cand.title} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="headline">{cand.title}</Text>
              <Text variant="caption" secondary>{cand.storeName}</Text>
              <Text variant="caption" secondary>{t("returns.windowDelivered", { date: day(e.deliveredAt) })}</Text>
            </View>
          </View>
          {!e.eligible ? <Banner tone="error" prefix={t("returns.notEligible")} message={e.message !== null ? pickText(e.message, lang) : t("returns.blockers.notEligible")} /> : null}
          {e.eligible && e.message !== null ? <Banner tone="info" message={pickText(e.message, lang)} /> : null}
          {win !== null ? (
            win.open ? (
              <Text variant="callout" secondary>{t("returns.windowOpen", { days: localizeDigits(String(win.days), locale), left: localizeDigits(String(win.daysLeft), locale), until: day(new Date(win.endsAtMs).toISOString()) })}</Text>
            ) : (
              <Banner tone="warning" message={t("returns.windowClosed", { until: day(new Date(win.endsAtMs).toISOString()) })} />
            )
          ) : null}
          <Text variant="caption" secondary>{t(`returns.shippingPaid.${e.returnShippingPaidBy}`)}</Text>

          {e.eligible ? (
            <>
              <Flow index={0}><Section step="01" title={t("returns.reasonHeading")}>
                <View accessibilityRole="radiogroup">
                  {RETURN_REASONS.map((r) => (
                    <Choice key={r} testID={`returns-reason-${r}`} label={t(`returns.reason.${r}`)} selected={draft.reason === r} onPress={() => setDraft(setReason(draft, r, e))} />
                  ))}
                </View>
                {showErrors && blockers.includes("reason") ? <Text variant="caption" color="danger">{t("returns.blockers.reason")}</Text> : null}
              </Section></Flow>

              {draft.reason !== null ? (
                <>
                  <Flow index={1}><Section step="02" title={t("returns.resolutionHeading")}>
                    <View accessibilityRole="radiogroup">
                      {options.map((o) => (
                        <Choice key={o} label={t(`returns.${o}`)} selected={draft.resolution === o}
                          detail={o === "exchange" ? <Text variant="caption" secondary>{t("returns.exchangeNote")}</Text> : undefined}
                          onPress={() => setDraft({ ...draft, resolution: o, refundTarget: null })} />
                      ))}
                    </View>
                    {draft.resolution === "refund" && e.allowedRefundTargets.length > 1 ? (
                      <View style={{ gap: spacing.sm }}>
                        <Text variant="callout" weight="600">{t("returns.refundTargetHeading")}</Text>
                        <View accessibilityRole="radiogroup">
                          {e.allowedRefundTargets.map((rt) => (
                            <Choice key={rt} label={t(`returns.refundTarget.${rt}`)} selected={draft.refundTarget === rt} onPress={() => setDraft({ ...draft, refundTarget: rt })} />
                          ))}
                        </View>
                        {showErrors && blockers.includes("refundTarget") ? <Text variant="caption" color="danger">{t("returns.blockers.refundTarget")}</Text> : null}
                      </View>
                    ) : null}
                  </Section></Flow>

                  <Flow index={2}><Section step="03" title={t("returns.photosHeading")}>
                    <Text variant="callout" secondary>{t(photosRequired(draft.reason) ? "returns.photosRequired" : "returns.photosOptional")}</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
                      {draft.photos.map((p, i) => {
                        const u = uploads[p.uri]?.state ?? "uploading";
                        return (
                          <View key={p.uri} style={{ width: TILE, height: TILE * 1.25, backgroundColor: colors.fill, borderRadius: radius.md, overflow: "hidden" }}>
                            <Image source={{ uri: p.uri }} contentFit="cover" style={{ width: TILE, height: TILE * 1.25 }} accessibilityLabel={t("returns.photoName", { n: localizeDigits(String(i + 1), locale) })} />
                            {u !== "ready" ? (
                              <View style={{ position: "absolute", bottom: 0, start: 0, end: 0, backgroundColor: colors.glassSolid, paddingVertical: 2 }}>
                                <Text variant="caption" align="center" color={u === "failed" ? "danger" : "textSecondary"}>{t(u === "failed" ? "returns.uploadFailedShort" : "returns.uploadingShort")}</Text>
                              </View>
                            ) : null}
                            <PressScale accessibilityRole="button" accessibilityLabel={t("returns.removePhoto", { n: localizeDigits(String(i + 1), locale) })}
                              onPress={() => setDraft(removePhoto(draft, p.uri))} hitSlop={8} haptic={false}
                              style={{ position: "absolute", top: 0, end: 0 }}
                              innerStyle={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, borderRadius: radius.pill }}>
                              <Icon name="close" size={16} />
                            </PressScale>
                          </View>
                        );
                      })}
                      {draft.photos.length < MAX_PHOTOS ? (
                        <PressScale accessibilityRole="button" accessibilityLabel={t("returns.addPhoto")} onPress={addOne} haptic={false}
                          innerStyle={{ width: TILE, height: TILE * 1.25, borderWidth: 1, borderColor: colors.hairline, borderRadius: radius.md, alignItems: "center", justifyContent: "center", gap: 4 }}>
                          <Icon name="camera-outline" size={22} color="textSecondary" />
                          <Text variant="caption" secondary>{t("returns.addPhotoShort")}</Text>
                        </PressScale>
                      ) : null}
                    </View>
                    <Text variant="caption" secondary>{t("returns.photoCount", { count: localizeDigits(String(draft.photos.length), locale), max: localizeDigits(String(MAX_PHOTOS), locale) })}</Text>
                    {showErrors && blockers.includes("photos") ? <Text variant="caption" color="danger">{t("returns.blockers.photos")}</Text> : null}
                  </Section></Flow>

                  <Flow index={3}><Section step="04" title={t("returns.methodHeading")}>
                    <View accessibilityRole="radiogroup">
                      {(["pickup", "dropoff"] as const satisfies readonly ReturnMethod[]).map((m) => (
                        <Choice key={m} label={t(`returns.method.${m}`)} selected={draft.method === m} onPress={() => setDraft({ ...draft, method: m })} />
                      ))}
                    </View>
                  </Section></Flow>
                </>
              ) : null}
              {showErrors && blockers.includes("window") ? <Banner tone="error" message={t("returns.blockers.window")} /> : null}
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
