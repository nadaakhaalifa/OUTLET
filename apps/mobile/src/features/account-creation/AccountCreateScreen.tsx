import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Checkbox, IconButton, Text, TextField } from "../../ui";
import { DobCalendarSheet } from "./DobCalendarSheet";
import { draftFromSelection, selectionFromDraft, type CalDay } from "../dob-calendar";
import { TestId } from "../../components/TestId";
import { StepScaffold } from "../../components/Scaffold";
import { normalizeEgyptianPhone } from "../phone";
import { randomUrlSafeId } from "../../platform/random";
import { LanguageThemeToggle } from "../chrome/LanguageThemeToggle";
import { BRAND_ROUTE } from "../role-choice/model";
import { errorKeyFor } from "../../features/api-errors";
import { ageGateErrorKey, runAgeGate } from "../../features/age-gate";
import {
  EMPTY_DOB_FIELDS,
  INITIAL_ATTESTED,
  applyDobInput,
  civilToday,
  displayDobDraft,
  draftToFields,
  fieldsToDraft,
  validateDobDraft,
  type DobDraftIssue,
} from "../../features/dob";
import { sha256Hex } from "../../workspace";
import { setSignInOnly } from "../flow";
import { getGuestStore } from "../../state/ports";
import { wipeGuestData } from "../guest";
import { useServices } from "../../state/services";

/**
 * One screen creates the account: date of birth + 18+ attestation, terms, phone, then the code.
 * The age gate runs first and is unchanged; a refused age never reaches the phone step.
 */
export function AccountCreateScreen(props: { gate?: { readonly reason: string; readonly mergeRule: string; readonly cancelLabel: string; readonly onCancel: () => void } } = {}) {
  const gate = props.gate;
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  // One masked field: the draft is up to eight ASCII digits (DDMMYYYY). Nothing is prefilled.
  const [draft, setDraft] = useState(fieldsToDraft(EMPTY_DOB_FIELDS));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attested, setAttested] = useState(INITIAL_ATTESTED);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [phoneRaw, setPhoneRaw] = useState("");
  const [phoneErrorKey, setPhoneErrorKey] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [signInMode, setSignInMode] = useState(false);
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);

  // A shopper who already holds a session (restart mid-onboarding) only needs the age step.
  useEffect(() => {
    let alive = true;
    void services.tokens.load().then(
      (tk) => { if (alive) setAlreadySignedIn(tk !== null); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [services]);

  const submit = async () => {
    setPhoneErrorKey(null);
    if (!terms) {
      setErrorKey("onboarding.account.errorTerms");
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const deviceId = await services.installId();
      const outcome = await runAgeGate(draftToFields(draft), attested, deviceId, {
        port: services.ageGate,
        hasher: sha256Hex,
        clock: services.clock,
        loadBlock: services.loadSoftBlock,
        saveBlock: services.saveSoftBlock,
      });
      switch (outcome.kind) {
        case "invalid_date":
          setErrorKey(outcome.incomplete ? "onboarding.dob.errorIncomplete" : "onboarding.dob.errorInvalid");
          return;
        case "needs_attestation":
          setErrorKey("onboarding.dob.errorAttest");
          return;
        case "blocked":
          // Only the hashed device block is kept. The date typed here is dropped, never stored.
          await services.tokens.clear();
          await wipeGuestData(getGuestStore(), services.storage); // E9: store and size profile
          services.session.pendingDob = null;
          router.replace("/onboarding/blocked");
          return;
        case "error":
          setErrorKey(ageGateErrorKey(outcome.reason));
          setOffline(outcome.reason === "network");
          return;
        case "allowed": {
          setOffline(false);
          setLimited(outcome.limitedCapacity);
          const tokens = await services.tokens.load();
          if (tokens !== null) {
            // Signed in on this install already (restart or existing account): submit now.
            const result = await services.api.submitAge({ dob: outcome.dob, attestedAtLeast18: true });
            if (!result.ok) {
              setErrorKey(errorKeyFor(result.error.code));
              return;
            }
            await services.setResume("consents");
            await services.analytics.trackOnboardingStep("account", false);
            router.replace("/onboarding/consents");
            return;
          }
          const phone = normalizeEgyptianPhone(phoneRaw);
          if (!phone.ok) {
            setPhoneErrorKey(
              phone.reason === "empty"
                ? "onboarding.phone.errorEmpty"
                : phone.reason === "country_not_supported"
                  ? "onboarding.phone.errorCountry"
                  : "onboarding.phone.errorInvalid",
            );
            return;
          }
          // First pass: keep the date in memory only; it is sent once after the phone is verified.
          services.session.pendingDob = outcome.dob;
          const sent = await services.api.requestOtp({
            phoneE164: phone.e164,
            locale: i18n.language === "en" ? "en" : "ar",
            idempotencyKey: randomUrlSafeId(24),
          });
          if (!sent.ok) {
            setErrorKey(errorKeyFor(sent.error.code));
            return;
          }
          services.session.phoneE164 = phone.e164;
          setSignInOnly(signInMode);
          services.session.sendsSoFar = sent.value.sendsSoFar;
          services.session.lastSentAtMs = services.clock.now().getTime();
          await services.setResume("phone");
          await services.analytics.trackOnboardingStep("account", false);
          router.push("/onboarding/otp");
          return;
        }
      }
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const today = civilToday(services.clock.now());
  const status = validateDobDraft(draft, today);
  const issueKey: Record<DobDraftIssue, string> = {
    invalid_day: "onboarding.dob.errorDay",
    invalid_month: "onboarding.dob.errorMonth",
    invalid_date: "onboarding.dob.errorDate",
    year_range: "onboarding.dob.errorYearRange",
    future: "onboarding.dob.errorFuture",
  };
  const inlineError = status.state === "error" ? t(issueKey[status.issue]) : undefined;

  const onDraftChange = (text: string) => {
    setErrorKey((k) => (k === "onboarding.dob.errorAttest" ? k : null));
    setDraft((prev) => applyDobInput(prev, text));
  };

  const openPicker = () => setPickerOpen(true);
  const confirmPick = (day: CalDay) => {
    const d = draftFromSelection(day, today);
    if (d !== null) setDraft(d);
    setErrorKey((k) => (k === "onboarding.dob.errorAttest" ? k : null));
    setPickerOpen(false);
  };

  const fieldError = errorKey !== null && errorKey !== "onboarding.dob.errorAttest" && errorKey !== "onboarding.account.errorTerms" ? t(errorKey) : undefined;

  return (
    <StepScaffold
      step="account"
      title={signInMode ? t("onboarding.account.titleSignIn") : t("onboarding.account.title")}
      body={signInMode ? t("onboarding.account.bodySignIn") : t("onboarding.account.body")}
      topEnd={<LanguageThemeToggle />}
    >
      {gate !== undefined ? (
        <View testID="checkout-gate-reason" style={{ gap: spacing.sm }}>
          <Banner tone="info" message={gate.reason} />
          <Text variant="caption" secondary>{gate.mergeRule}</Text>
        </View>
      ) : null}
      {/* One field, order day / month / year in both languages; digits are kept left-to-right. */}
      <View>
        <TestId id="dob-input">
          <TextField
            label={t("onboarding.dob.field")}
            value={displayDobDraft(draft)}
            onChangeText={onDraftChange}
            keyboardType="numeric"
            placeholder={t("onboarding.dob.placeholder")}
            helper={t("onboarding.dob.hint")}
            error={inlineError}
            trailing={(
              <View testID="dob-calendar-button">
                <IconButton icon="calendar-outline" label={t("onboarding.dob.pickFromCalendar")} onPress={openPicker} />
              </View>
            )}
          />
        </TestId>
      </View>
      <DobCalendarSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} selected={selectionFromDraft(draft, today)} today={today} onDone={confirmPick} />
      {fieldError !== undefined ? <Banner tone="error" message={fieldError} /> : null}
      <Text variant="caption" secondary>{t("onboarding.dob.privacyNote")}</Text>
      <TestId id="dob-attest"><Checkbox label={t("onboarding.dob.attest")} value={attested} onValueChange={setAttested} /></TestId>
      {errorKey === "onboarding.dob.errorAttest" ? <Banner tone="error" message={t(errorKey)} /> : null}
      {alreadySignedIn ? null : (
        <TestId id="phone-input"><TextField
          label={t("onboarding.phone.label")}
          value={phoneRaw}
          onChangeText={(v) => { setPhoneRaw(v); setPhoneErrorKey(null); }}
          placeholder={t("onboarding.phone.placeholder")}
          helper={t("onboarding.phone.helper")}
          keyboardType="phone-pad"
          {...(phoneErrorKey !== null ? { error: t(phoneErrorKey) } : {})}
        /></TestId>
      )}
      <TestId id="terms-accept"><Checkbox label={t("onboarding.account.termsLabel")} value={terms} onValueChange={(v) => { setTerms(v); setErrorKey((k) => (k === "onboarding.account.errorTerms" ? null : k)); }} /></TestId>
      {errorKey === "onboarding.account.errorTerms" ? <Banner tone="error" message={t(errorKey)} /> : null}
      {limited ? <Banner tone="info" message={t("onboarding.dob.limitedCapacity")} /> : null}
      {busy ? <Text variant="caption" secondary>{t("onboarding.dob.checking")}</Text> : null}
      <Button
        title={offline ? t("common.retry") : alreadySignedIn ? t("onboarding.dob.submit") : t("onboarding.account.send")}
        variant="brand"
        testID="dob-submit"
        onPress={() => void submit()}
        loading={busy}
        disabled={busy}
      />
      <Button title={t("legalCombined.link")} variant="ghost" onPress={() => router.push("/legal/combined" as Href)} testID="terms-privacy-link" />
      {gate !== undefined ? (
        <Button title={gate.cancelLabel} variant="ghost" onPress={gate.onCancel} disabled={busy} testID="checkout-gate-back" />
      ) : (
        <Button title={t("onboarding.account.openStore")} variant="ghost" onPress={() => router.replace(BRAND_ROUTE as Href)} disabled={busy} />
      )}
      <Button
        title={signInMode ? t("onboarding.account.createLink") : t("onboarding.account.signInLink")}
        variant="ghost"
        testID="gate-sign-in-toggle"
        onPress={() => setSignInMode((m) => !m)}
        disabled={busy}
      />
    </StepScaffold>
  );
}
