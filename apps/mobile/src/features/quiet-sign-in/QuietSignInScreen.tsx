import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Checkbox, LoadingState, Screen, Text, TextField } from "../../ui";
import { TestId } from "../../components/TestId";
import { Ticker } from "../../components/Ticker";
import { errorKeyFor } from "../api-errors";
import { ageGateErrorKey, runAgeGate } from "../age-gate";
import { EMPTY_DOB_FIELDS, INITIAL_ATTESTED, applyDobInput, civilToday, displayDobDraft, draftToFields, fieldsToDraft, validateDobDraft, type DobDraftIssue } from "../dob";
import { isCompleteOtp, resendExhausted, resendRemainingSeconds, sanitizeOtp } from "../otp";
import { maskPhone, normalizeEgyptianPhone } from "../phone";
import { ApiMergeTransport, newMergeKey, noteText, runGuestMerge, type MergeSummary } from "../guest";
import { randomUrlSafeId } from "../../platform/random";
import { getApiRuntime, getSharedClient } from "../../services/runtime";
import { getGuestStore } from "../../state/ports";
import { useServices } from "../../state/services";
import { sha256Hex } from "../../workspace";
import { runQuietVerify } from "./model";

type Phase =
  | { readonly kind: "form" }
  | { readonly kind: "code" }
  | { readonly kind: "merging" }
  | { readonly kind: "merge_failed" }
  | { readonly kind: "summary"; readonly summary: MergeSummary }
  | { readonly kind: "no_account" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "already" };

/**
 * Existing-account sign-in (ADR-0055 F5). Not a create-account flow: no consents step, no terms box, and a number with no
 * account gets an honest message and a way back to shopping; nothing is created. The age check still runs first because
 * the server requires it before an OTP (gap G-9 removes this step).
 */
export function QuietSignInScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [draft, setDraft] = useState(fieldsToDraft(EMPTY_DOB_FIELDS));
  const [attested, setAttested] = useState(INITIAL_ATTESTED);
  const [phoneRaw, setPhoneRaw] = useState("");
  const [code, setCode] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [phoneErrorKey, setPhoneErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<string | null>(null);
  const nowFn = useCallback(() => services.clock.now().getTime(), [services]);

  useEffect(() => {
    let alive = true;
    void services.tokens.load().then((tk) => { if (alive && tk !== null) setPhase({ kind: "already" }); }, () => undefined);
    return () => { alive = false; };
  }, [services]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as Href);
  }, [router]);

  const sendCode = async () => {
    setErrorKey(null);
    setPhoneErrorKey(null);
    setBusy(true);
    try {
      const outcome = await runAgeGate(draftToFields(draft), attested, await services.installId(), {
        port: services.ageGate, hasher: sha256Hex, clock: services.clock, loadBlock: services.loadSoftBlock, saveBlock: services.saveSoftBlock,
      });
      switch (outcome.kind) {
        case "invalid_date": setErrorKey(outcome.incomplete ? "onboarding.dob.errorIncomplete" : "onboarding.dob.errorInvalid"); return;
        case "needs_attestation": setErrorKey("onboarding.dob.errorAttest"); return;
        case "blocked":
          await services.tokens.clear();
          await getGuestStore().clearAll();
          router.replace("/onboarding/blocked");
          return;
        case "error": setErrorKey(ageGateErrorKey(outcome.reason)); return;
        case "allowed": break;
      }
      const phone = normalizeEgyptianPhone(phoneRaw);
      if (!phone.ok) {
        setPhoneErrorKey(phone.reason === "empty" ? "onboarding.phone.errorEmpty" : phone.reason === "country_not_supported" ? "onboarding.phone.errorCountry" : "onboarding.phone.errorInvalid");
        return;
      }
      const sent = await services.api.requestOtp({ phoneE164: phone.e164, locale: i18n.language === "en" ? "en" : "ar", idempotencyKey: randomUrlSafeId(24) });
      if (!sent.ok) { setErrorKey(errorKeyFor(sent.error.code)); return; }
      phoneRef.current = phone.e164;
      services.session.sendsSoFar = sent.value.sendsSoFar;
      services.session.lastSentAtMs = services.clock.now().getTime();
      setPhase({ kind: "code" });
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    const phone = phoneRef.current;
    if (phone === null) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await services.api.requestOtp({ phoneE164: phone, locale: i18n.language === "en" ? "en" : "ar", idempotencyKey: randomUrlSafeId(24) });
      if (!r.ok) { setErrorKey(errorKeyFor(r.error.code)); return; }
      services.session.sendsSoFar = r.value.sendsSoFar;
      services.session.lastSentAtMs = services.clock.now().getTime();
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const merge = useCallback(async () => {
    setPhase({ kind: "merging" });
    const runtime = getApiRuntime();
    if (runtime === null) { leave(); return; } // no backend (fixture mode): nothing to merge into
    try {
      const out = await runGuestMerge({
        store: getGuestStore(),
        transport: new ApiMergeTransport(getSharedClient(runtime)),
        newKey: newMergeKey,
        includeViewed: services.consent.isGranted("personalization"),
      });
      if (out.kind === "failed") { setPhase({ kind: "merge_failed" }); return; }
      if (out.kind === "done" && out.summary.changed) { setPhase({ kind: "summary", summary: out.summary }); return; }
      leave();
    } catch {
      setPhase({ kind: "merge_failed" });
    }
  }, [leave, services]);

  const verify = async () => {
    const phone = phoneRef.current;
    if (phone === null) return;
    if (!isCompleteOtp(code)) { setErrorKey("onboarding.otp.errorIncomplete"); return; }
    setBusy(true);
    setErrorKey(null);
    try {
      const outcome = await runQuietVerify(
        { verifyOtp: (i) => services.api.verifyOtp(i), save: (tk) => services.tokens.save(tk), markOnboardingDone: () => services.markOnboardingDone() },
        phone,
        code,
      );
      if (outcome.kind === "error") { setErrorKey(outcome.errorKey); return; }
      if (outcome.kind === "no_account") { setPhase({ kind: "no_account" }); return; }
      if (outcome.kind === "unavailable") { setPhase({ kind: "unavailable" }); return; }
      void services.role.flushFunnel?.();
      void services.consent.flushPending().catch(() => undefined);
      await merge();
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const today = civilToday(services.clock.now());
  const status = validateDobDraft(draft, today);
  const issueKey: Record<DobDraftIssue, string> = {
    invalid_day: "onboarding.dob.errorDay", invalid_month: "onboarding.dob.errorMonth", invalid_date: "onboarding.dob.errorDate",
    year_range: "onboarding.dob.errorYearRange", future: "onboarding.dob.errorFuture",
  };
  const inlineError = status.state === "error" ? t(issueKey[status.issue]) : undefined;
  const fieldError = errorKey !== null && errorKey !== "onboarding.dob.errorAttest" ? t(errorKey) : undefined;

  return (
    <Screen onBack={leave} backLabel={t("common.back")} testID="quiet-sign-in">
      {phase.kind === "form" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="display" accessibilityRole="header">{t("quietSignIn.title")}</Text>
          <Text variant="body" secondary>{t("quietSignIn.body")}</Text>
          <Text variant="caption" secondary>{t("quietSignIn.ageNote")}</Text>
          <TestId id="signin-dob-input">
            <TextField
              label={t("onboarding.dob.field")} value={displayDobDraft(draft)} keyboardType="numeric" placeholder={t("onboarding.dob.placeholder")}
              helper={t("onboarding.dob.hint")} error={inlineError}
              onChangeText={(v) => { setErrorKey((k) => (k === "onboarding.dob.errorAttest" ? k : null)); setDraft((p) => applyDobInput(p, v)); }}
            />
          </TestId>
          <Text variant="caption" secondary>{t("onboarding.dob.privacyNote")}</Text>
          <TestId id="signin-dob-attest"><Checkbox label={t("onboarding.dob.attest")} value={attested} onValueChange={setAttested} /></TestId>
          {errorKey === "onboarding.dob.errorAttest" ? <Banner tone="error" message={t(errorKey)} /> : null}
          <TestId id="signin-phone-input">
            <TextField
              label={t("onboarding.phone.label")} value={phoneRaw} keyboardType="phone-pad" placeholder={t("onboarding.phone.placeholder")}
              helper={t("onboarding.phone.helper")} onChangeText={(v) => { setPhoneRaw(v); setPhoneErrorKey(null); }}
              {...(phoneErrorKey !== null ? { error: t(phoneErrorKey) } : {})}
            />
          </TestId>
          {fieldError !== undefined ? <Banner tone="error" message={fieldError} /> : null}
          <Button variant="brand" testID="signin-send" title={t("quietSignIn.sendCode")} onPress={() => void sendCode()} loading={busy} disabled={busy} />
        </View>
      ) : null}

      {phase.kind === "code" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="display" accessibilityRole="header">{t("quietSignIn.title")}</Text>
          <Text variant="body" secondary>{t("onboarding.otp.body", { phone: maskPhone(phoneRef.current ?? "") })}</Text>
          <TestId id="signin-otp-input">
            <TextField label={t("onboarding.otp.label")} value={code} keyboardType="numeric" onChangeText={(v) => setCode(sanitizeOtp(v))} {...(fieldError !== undefined ? { error: fieldError } : {})} />
          </TestId>
          <Button variant="brand" testID="signin-verify" title={t("quietSignIn.verify")} onPress={() => void verify()} loading={busy} disabled={busy} />
          <Ticker nowFn={nowFn} render={(nowMs) => {
            const remaining = resendRemainingSeconds(services.session.sendsSoFar, services.session.lastSentAtMs, nowMs);
            const exhausted = resendExhausted(services.session.sendsSoFar) && remaining === 0;
            return (
              <>
                {remaining > 0 ? <Text secondary>{t("onboarding.otp.resendIn", { seconds: remaining })}</Text> : null}
                {exhausted ? <Text secondary>{t("onboarding.otp.resendExhausted")}</Text> : null}
                {remaining === 0 && !exhausted ? <Button title={t("onboarding.otp.resend")} variant="ghost" onPress={() => void resend()} disabled={busy} /> : null}
              </>
            );
          }} />
          <Button variant="ghost" title={t("quietSignIn.changeNumber")} onPress={() => { setCode(""); setErrorKey(null); setPhase({ kind: "form" }); }} disabled={busy} />
        </View>
      ) : null}

      {phase.kind === "merging" ? <LoadingState label={t("guestMerge.moving")} /> : null}

      {phase.kind === "merge_failed" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("guestMerge.failedTitle")}</Text>
          <Text variant="body" secondary>{t("guestMerge.failedBody")}</Text>
          <Button variant="brand" title={t("guestMerge.retry")} onPress={() => void merge()} />
          <Button variant="ghost" title={t("quietSignIn.mergeContinueWithout")} onPress={leave} />
        </View>
      ) : null}

      {phase.kind === "summary" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("guestMerge.summaryTitle")}</Text>
          {phase.summary.notes.map((n, i) => <Banner key={`${n.kind}-${i}`} tone="info" message={t(noteText(n).key, noteText(n).params)} />)}
          {phase.summary.savedOverCap > 0 ? <Banner tone="info" message={t("guestMerge.savedOverCap", { max: 200 })} /> : null}
          {phase.summary.savedUnavailable > 0 ? <Banner tone="info" message={t("guestMerge.savedUnavailable")} /> : null}
          <Button variant="brand" testID="signin-merge-continue" title={t("quietSignIn.mergeContinue")} onPress={leave} />
          <Button variant="ghost" testID="signin-merge-review-bag" title={t("guestMerge.reviewBag")} onPress={() => router.replace("/(tabs)/bag" as Href)} />
        </View>
      ) : null}

      {phase.kind === "no_account" ? (
        <View style={{ gap: spacing.md }} testID="signin-no-account">
          <Text variant="title1" accessibilityRole="header">{t("quietSignIn.noAccountTitle")}</Text>
          <Text variant="body" secondary>{t("quietSignIn.noAccountBody")}</Text>
          <Button variant="brand" testID="signin-back-to-shopping" title={t("quietSignIn.backToShopping")} onPress={() => router.replace("/(tabs)" as Href)} />
        </View>
      ) : null}

      {phase.kind === "unavailable" ? (
        <View style={{ gap: spacing.md }} testID="signin-unavailable">
          <Text variant="title1" accessibilityRole="header">{t("quietSignIn.unavailableTitle")}</Text>
          <Text variant="body" secondary>{t("quietSignIn.unavailableBody")}</Text>
          <Button variant="brand" testID="signin-unavailable-back" title={t("quietSignIn.backToShopping")} onPress={() => router.replace("/(tabs)" as Href)} />
        </View>
      ) : null}

      {phase.kind === "already" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("quietSignIn.alreadyTitle")}</Text>
          <Button variant="brand" title={t("quietSignIn.backToShopping")} onPress={leave} />
        </View>
      ) : null}
    </Screen>
  );
}
