import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, Text, TextField } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { TestId } from "../../components/TestId";
import { takeAdmission } from "../drops/admissionStore";
import type { AdmissionToken } from "../drops/model";
import { Choice } from "./Choice";
import {
  EMPTY_ADDRESS, applyOrderStatus, applyPlaceFailure, applyPlaceResult,
  beginSubmit, buildPlaceRequest, checkoutFailureState, citiesFor, computeTotals, initialSelection, installmentLine, needsReconfirmation,
  pickText, placeBlockers, requestFingerprint, setGovernorate, uuidv7, validateAddress, visiblePaymentMethods,
  type AddressDraft, type AddressField, type CheckoutPort, type CheckoutScreenState, type CheckoutSelection, type ClientAction,
  type MapPinPort, type PaymentLauncherPort, type Submission,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

export interface CheckoutScreenProps {
  readonly port?: CheckoutPort;
  readonly launcher?: PaymentLauncherPort;
  readonly mapPin?: MapPinPort;
  /** Set when the shopper returns from the Orders tab to an unfinished payment. */
  readonly resumeOrderGroupId?: string;
  readonly onViewOrders?: () => void;
  /** Set when the shopper arrives from a drop; the waiting-room admission token is taken from memory, once. */
  readonly dropId?: string;
}

/** Dev fixtures only; production wiring replaces the ports when the API client and PSP adapters land. */
export function CheckoutScreen(props: CheckoutScreenProps) {
  const { t, i18n } = useTranslation();
  const lang: "ar" | "en" = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<CheckoutPort>(() => props.port ?? getFeaturePorts().checkout, [props.port]);
  const launcher = useMemo<PaymentLauncherPort>(() => props.launcher ?? getFeaturePorts().paymentLauncher, [props.launcher]);
  const mapPin = useMemo<MapPinPort>(() => props.mapPin ?? getFeaturePorts().mapPin, [props.mapPin]);
  const currency = t("common.currency");
  const money = useCallback((m: bigint) => formatMoney(m, locale, currency), [locale, currency]);

  // Single-use handoff from the drop screen (memory only, never in the URL). Kept in state so retries reuse it.
  const [admission] = useState<AdmissionToken | null>(() => (props.dropId !== undefined && props.dropId !== "" ? takeAdmission(props.dropId) : null));
  const admissionMissing = props.dropId !== undefined && props.dropId !== "" && admission === null;
  const [state, setState] = useState<CheckoutScreenState>({ status: "loading" });
  const [sel, setSel] = useState<CheckoutSelection | null>(null);
  const [reconfirmed, setReconfirmed] = useState<bigint | null>(null);
  const [submission, setSubmission] = useState<Submission>(
    props.resumeOrderGroupId !== undefined ? { status: "awaitingPayment", key: "", fingerprint: "", orderGroupId: props.resumeOrderGroupId } : { status: "idle" },
  );
  const [action, setAction] = useState<ClientAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const q = await port.quote({ address: EMPTY_ADDRESS });
      setState({ status: "ready", quote: q });
      setSel((prev) => prev ?? initialSelection(q));
    } catch (e) {
      setState(checkoutFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const checkStatus = useCallback(async (s: Extract<Submission, { status: "awaitingPayment" }>) => {
    try {
      const st = await port.orderGroupStatus(s.orderGroupId);
      setSubmission(applyOrderStatus(s, st));
    } catch {
      setNotice(t("checkout.networkRetry"));
    }
  }, [port, t]);

  // Resume from the Orders tab: the server, not the redirect, decides the outcome.
  useEffect(() => {
    if (props.resumeOrderGroupId !== undefined) {
      void checkStatus({ status: "awaitingPayment", key: "", fingerprint: "", orderGroupId: props.resumeOrderGroupId });
    }
  }, [props.resumeOrderGroupId, checkStatus]);

  const quote = state.status === "ready" ? state.quote : null;
  const totals = quote !== null && sel !== null ? computeTotals(quote, sel) : null;
  const method = quote !== null && sel !== null ? visiblePaymentMethods(quote).find((m) => m.id === sel.paymentMethodId) : undefined;
  const codSelected = method?.kind === "cod";
  const blockers = quote !== null && sel !== null ? placeBlockers(quote, sel, reconfirmed) : [];
  const addrErrors = quote !== null && sel !== null ? validateAddress(sel.address, quote.coverage, codSelected) : [];

  const update = (patch: Partial<CheckoutSelection>) => {
    setSel((s) => (s === null ? s : { ...s, ...patch }));
    setSubmission((s) => (s.status === "failed" ? { status: "idle" } : s));
  };
  const setAddr = (patch: Partial<AddressDraft>): void => {
    if (sel !== null) update({ address: { ...sel.address, ...patch } });
  };
  const errFor = (field: AddressField, key: string): { error?: string } =>
    showErrors && addrErrors.includes(field) ? { error: t(key) } : {};

  const place = async () => {
    if (quote === null || sel === null || totals === null || inFlight.current || admissionMissing) return;
    setShowErrors(true);
    if (blockers.length > 0) return;
    const request = buildPlaceRequest(quote, sel, totals);
    let step;
    try {
      step = beginSubmit(submission, requestFingerprint(request), newIdempotencyKey);
    } catch {
      setNotice(t("checkout.failedGeneric"));
      return;
    }
    if (!step.start) return;
    inFlight.current = true;
    setNotice(null);
    setSubmission(step.submission);
    const submitting = step.submission as Extract<Submission, { status: "submitting" }>;
    try {
      const result = await port.place(request, step.key, admission?.value ?? null);
      const out = applyPlaceResult(submitting, result, codSelected);
      if (out.quote !== null) {
        setState({ status: "ready", quote: out.quote });
        setReconfirmed(null);
      }
      setSubmission(out.submission);
      if (result.kind === "requires_action") {
        setAction(result.action);
        if (result.action.type !== "none" && result.action.type !== "reference_code") {
          const outcome = await launcher.launch(result.action);
          if (outcome === "cancelled") setNotice(t("checkout.paymentCancelled"));
        }
        if (out.submission.status === "awaitingPayment") await checkStatus(out.submission);
      }
    } catch {
      setSubmission(applyPlaceFailure(submitting));
      setNotice(t("checkout.networkRetry"));
    } finally {
      inFlight.current = false;
    }
  };

  const busy = submission.status === "submitting";
  const amount = (m: bigint) => money(m);
  const stateBlock = (
    <>
      {state.status === "loading" ? <LoadingState label={t("checkout.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "checkout.offlineTitle" : "checkout.errorTitle")}
          description={t(state.offline ? "checkout.offlineBody" : "checkout.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
    </>
  );

  if (submission.status === "done") {
    return (
      <Screen>
        <Text variant="title">{t("checkout.doneTitle")}</Text>
        <Banner tone="info" message={t(submission.cod ? "checkout.doneCod" : "checkout.doneBody")} prefix={t("checkout.doneTitle")} />
        {props.onViewOrders !== undefined ? <Button title={t("checkout.viewOrders")} onPress={props.onViewOrders} /> : null}
      </Screen>
    );
  }
  if (submission.status === "awaitingPayment") {
    return (
      <Screen>
        <Text variant="title">{t("checkout.awaitingTitle")}</Text>
        <Text secondary>{t("checkout.awaitingBody")}</Text>
        {action?.type === "reference_code" ? <Banner tone="info" message={t("checkout.referenceCode", { code: action.code })} /> : null}
        {notice !== null ? <Banner tone="warning" message={notice} /> : null}
        <Button title={t("checkout.checkStatus")} onPress={() => void checkStatus(submission)} />
        {props.onViewOrders !== undefined ? <Button variant="secondary" title={t("checkout.viewOrders")} onPress={props.onViewOrders} /> : null}
      </Screen>
    );
  }

  return (
    <Screen>
      <Text variant="title">{t("checkout.title")}</Text>
      {stateBlock}
      {admissionMissing ? <Banner tone="error" message={t("nav.admissionMissing")} /> : null}
      {quote !== null && sel !== null && totals !== null ? (
        quote.shipments.every((s) => s.lines.length === 0) ? (
          <EmptyState title={t("checkout.emptyTitle")} description={t("checkout.emptyBody")} />
        ) : (
          <>
            {/* 1. Address */}
            <Card>
              <Text variant="heading">{t("checkout.addressHeading")}</Text>
              <Text variant="caption" secondary>{t("checkout.governorate")}</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.governorate")} style={{ gap: spacing.xs }}>
                {quote.coverage.map((g) => (
                  <Choice key={g.id} label={pickText(g.name, lang)} selected={sel.address.governorateId === g.id}
                    onPress={() => update({ address: setGovernorate(sel.address, quote.coverage, g.id) })}
                    accessibilityLabel={t("checkout.choose", { name: pickText(g.name, lang) })} />
                ))}
              </View>
              {showErrors && addrErrors.includes("governorate") ? <Banner tone="error" message={t("checkout.addressErrors.governorate")} /> : null}
              {sel.address.governorateId !== null ? (
                <>
                  <Text variant="caption" secondary>{t("checkout.city")}</Text>
                  <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.city")} style={{ gap: spacing.xs }}>
                    {citiesFor(quote.coverage, sel.address.governorateId).map((c) => (
                      <Choice key={c.id} label={pickText(c.name, lang)} selected={sel.address.cityId === c.id}
                        onPress={() => setAddr({ cityId: c.id })} accessibilityLabel={t("checkout.choose", { name: pickText(c.name, lang) })} />
                    ))}
                  </View>
                  {showErrors && addrErrors.includes("city") ? <Banner tone="error" message={t("checkout.addressErrors.city")} /> : null}
                </>
              ) : null}
              <TextField label={t("checkout.street")} value={sel.address.street} onChangeText={(v) => setAddr({ street: v })}
                {...errFor("street", "checkout.addressErrors.street")} />
              <TextField label={t("checkout.building")} value={sel.address.building} onChangeText={(v) => setAddr({ building: v })}
                {...errFor("building", "checkout.addressErrors.building")} />
              <TextField label={t("checkout.floor")} value={sel.address.floor} onChangeText={(v) => setAddr({ floor: v })} />
              <TextField label={t("checkout.apartment")} value={sel.address.apartment} onChangeText={(v) => setAddr({ apartment: v })} />
              <TextField label={t("checkout.landmark")} value={sel.address.landmark} onChangeText={(v) => setAddr({ landmark: v })}
                {...errFor("landmark", "checkout.addressErrors.landmark")} />
              <Button variant="secondary" title={t(sel.address.pin === null ? "checkout.pickOnMap" : "checkout.pinChange")}
                onPress={() => void mapPin.pick(sel.address.pin).then((p) => { if (p !== null) setAddr({ pin: p }); })} />
              {sel.address.pin !== null ? <Text variant="caption" secondary>{t("checkout.pinSet")}</Text> : null}
              {showErrors && addrErrors.includes("pin") ? <Banner tone="error" message={t("checkout.addressErrors.pin")} /> : null}
            </Card>

            {/* 2. Delivery per shipment */}
            <Card>
              <Text variant="heading">{t("checkout.deliveryHeading")}</Text>
              {quote.shipments.filter((s) => s.lines.length > 0).map((s) => (
                <View key={s.id} style={{ gap: spacing.xs }}>
                  <Text>{t("checkout.deliveryFrom", { store: s.storeName })}</Text>
                  {s.lines.map((l) => (
                    <Text key={l.lineId} variant="caption" secondary>
                      {t("checkout.lineSummary", { title: l.title, qty: localizeDigits(String(l.qty), locale), amount: amount(l.unitPrice * BigInt(l.qty)) })}
                    </Text>
                  ))}
                  <View accessibilityRole="radiogroup" style={{ gap: spacing.xs }}>
                    {s.deliveryOptions.map((o) => (
                      <Choice key={o.id} selected={sel.delivery[s.id] === o.id}
                        label={t("checkout.deliveryOption", { name: pickText(o.name, lang), days: localizeDigits(String(o.etaDays), locale), fee: o.fee === 0n ? t("checkout.free") : amount(o.fee) })}
                        onPress={() => update({ delivery: { ...sel.delivery, [s.id]: o.id } })} />
                    ))}
                  </View>
                </View>
              ))}
              {showErrors && blockers.includes("delivery") ? <Banner tone="error" message={t("checkout.blockers.delivery")} /> : null}
            </Card>

            {/* 3. Payment */}
            <Card>
              <Text variant="heading">{t("checkout.paymentHeading")}</Text>
              {totals.payable === 0n ? <Text secondary>{t("checkout.noExternalNeeded")}</Text> : (
                <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.paymentHeading")} style={{ gap: spacing.xs }}>
                  {visiblePaymentMethods(quote).map((m) => {
                    const inst = installmentLine(m);
                    const reason = m.unavailableReason !== null ? pickText(m.unavailableReason, lang) : null;
                    return (
                      <Choice key={m.id} label={pickText(m.name, lang)} selected={sel.paymentMethodId === m.id} disabled={!m.available}
                        onPress={() => update({ paymentMethodId: m.id })}
                        detail={
                          <>
                            {!m.available ? <Text variant="caption" secondary>{reason !== null ? t("checkout.methodUnavailable", { reason }) : t("checkout.methodUnavailableGeneric")}</Text> : null}
                            {m.available && inst !== null ? (
                              <>
                                <Text variant="caption" secondary>
                                  {t("checkout.installmentLine", { provider: inst.providerName, monthly: amount(inst.monthly), months: localizeDigits(String(inst.tenorMonths), locale) })}
                                </Text>
                                <Text variant="caption" secondary>{t("checkout.installmentFee", { amount: amount(inst.adminFee) })}</Text>
                                {inst.termsUrl.startsWith("https://") ? (
                                  <Button variant="secondary" title={t("checkout.installmentTerms", { provider: inst.providerName })} onPress={() => void Linking.openURL(inst.termsUrl)} />
                                ) : null}
                              </>
                            ) : null}
                            {m.note !== null ? <Text variant="caption" secondary>{pickText(m.note, lang)}</Text> : null}
                          </>
                        } />
                    );
                  })}
                </View>
              )}
              {showErrors && (blockers.includes("paymentMethod") || blockers.includes("methodUnavailable")) ? (
                <Banner tone="error" message={t(blockers.includes("paymentMethod") ? "checkout.blockers.paymentMethod" : "checkout.blockers.methodUnavailable")} />
              ) : null}
            </Card>

            {/* 4. Vouchers and store credit (split tender) */}
            <Card>
              <Text variant="heading">{t("checkout.vouchersHeading")}</Text>
              {quote.vouchers.length === 0 ? <Text secondary>{t("checkout.noVouchers")}</Text> : quote.vouchers.map((v) => (
                <Choice key={v.code} role="checkbox" selected={sel.voucherCodes.includes(v.code)}
                  label={t("checkout.voucherLine", { code: v.code, amount: amount(v.discount) })}
                  accessibilityLabel={t("checkout.voucherToggleName", { code: v.code })}
                  onPress={() => update({ voucherCodes: sel.voucherCodes.includes(v.code) ? sel.voucherCodes.filter((c) => c !== v.code) : [...sel.voucherCodes, v.code] })} />
              ))}
              <Divider />
              <Text variant="heading">{t("checkout.creditHeading")}</Text>
              {quote.storeCreditBalance <= 0n ? <Text secondary>{t("checkout.creditNone")}</Text> : (
                <Choice role="checkbox" selected={sel.useStoreCredit} label={t("checkout.creditToggle", { balance: amount(quote.storeCreditBalance) })}
                  onPress={() => update({ useStoreCredit: !sel.useStoreCredit })} />
              )}
            </Card>

            {/* 5. Review: every fee on the first render */}
            <Card>
              <Text variant="heading">{t("checkout.reviewHeading")}</Text>
              <Text>{`${t("checkout.merchandise")}: ${amount(totals.merchandise)}`}</Text>
              {totals.shipments.map((s) => (
                <Text key={s.shipmentId}>{`${t("checkout.deliveryFrom", { store: s.storeName })}: ${s.delivery === 0n ? t("checkout.free") : amount(s.delivery)}`}</Text>
              ))}
              {quote.fees.map((f) => <Text key={f.id}>{`${pickText(f.name, lang)}: ${amount(f.amount)}`}</Text>)}
              {totals.voucherDiscount > 0n ? <Text>{`${t("checkout.voucherTotal")}: -${amount(totals.voucherDiscount)}`}</Text> : null}
              {totals.storeCreditApplied > 0n ? <Text>{`${t("checkout.creditTotal")}: -${amount(totals.storeCreditApplied)}`}</Text> : null}
              <Divider />
              <Text variant="heading">{t("checkout.total", { amount: amount(totals.totalBeforeCredit) })}</Text>
              <Text>{t("checkout.payable", { amount: amount(totals.payable) })}</Text>
              {totals.verifiedSavings > 0n ? <Text>{t("checkout.saved", { amount: amount(totals.verifiedSavings) })}</Text> : null}
              {!quote.isPlusMember && quote.plusSavings !== null && quote.plusSavings > 0n ? (
                <Text>{t("nav.plusNudge", { amount: amount(quote.plusSavings) })}</Text>
              ) : null}
              <Text variant="caption" secondary>{t("checkout.feesNote")}</Text>
              <Text variant="caption" secondary>{t("checkout.priceLock", { minutes: localizeDigits(String(Math.max(1, Math.round(quote.priceLockSeconds / 60))), locale) })}</Text>
            </Card>

            {totals.priceDelta !== 0n ? (
              <Card>
                <Banner tone="warning" prefix={t("checkout.priceRoseTitle")}
                  message={t(totals.priceDelta > 0n ? "checkout.priceRose" : "checkout.priceDropped", { amount: amount(totals.priceDelta > 0n ? totals.priceDelta : -totals.priceDelta) })} />
                {needsReconfirmation(totals, reconfirmed) ? (
                  <Button variant="secondary" title={t("checkout.acceptDelta")} onPress={() => setReconfirmed(totals.priceDelta)} />
                ) : null}
              </Card>
            ) : null}

            {submission.status === "failed" ? (
              <Banner tone="error" message={submission.reason !== null ? t("checkout.rejected", { reason: pickText(submission.reason, lang) }) : t(submission.retryable ? "checkout.networkRetry" : "checkout.failedGeneric")} />
            ) : null}
            {notice !== null ? <Banner tone="warning" message={notice} /> : null}
            {showErrors && blockers.length > 0 ? <Banner tone="error" message={t(`checkout.blockers.${blockers[0] ?? "emptyBag"}`)} /> : null}
            <TestId id="checkout-place-order">
              <Button title={t(busy ? "checkout.placing" : "checkout.placeOrder")} loading={busy} disabled={busy || admissionMissing} onPress={() => void place()} />
            </TestId>
          </>
        )
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
