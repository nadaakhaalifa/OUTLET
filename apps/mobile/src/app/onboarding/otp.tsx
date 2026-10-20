import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Button, Text, TextField } from "../../ui";
import { Ticker } from "../../components/Ticker";
import { TestId } from "../../components/TestId";
import { StepScaffold } from "../../components/Scaffold";
import { errorKeyFor } from "../../features/api-errors";
import { isCompleteOtp, resendExhausted, resendRemainingSeconds, sanitizeOtp } from "../../features/otp";
import { maskPhone } from "../../features/phone";
import { randomUrlSafeId } from "../../platform/random";
import { getGuestStore } from "../../state/ports";
import { wipeGuestData } from "../../features/guest";
import { isSignInOnly, setSignInOnly, setNewAccountSignUp, peekReturnTarget } from "../../features/flow";
import type { StepUpChallenge } from "../../api/port";
import { StepUpPanel } from "../../features/step-up/StepUpPanel";
import { useServices } from "../../state/services";

export default function OtpStep() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const phone = services.session.phoneE164;
  const [code, setCode] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [stepUp, setStepUp] = useState<StepUpChallenge | null>(null);
  const nowFn = useCallback(() => services.clock.now().getTime(), [services]);

  useEffect(() => {
    if (phone === null) router.replace("/onboarding/account");
  }, [phone, router]);
  if (phone === null) return null;

  const verify = async () => {
    if (!isCompleteOtp(code)) {
      setErrorKey("onboarding.otp.errorIncomplete");
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await services.api.verifyOtp({ phoneE164: phone, code, ...(isSignInOnly() ? { mode: "existing_only" as const } : {}) });
      if (!result.ok) {
        if (result.error.code === "no_account") {
          // Sign-in never creates an account: say so and offer the way back to sign-up.
          setNoAccount(true);
          return;
        }
        if (result.error.code === "step_up_required") {
          // Recycled number on a new install: no tokens yet. Never fall back to create mode.
          if (result.error.stepUp !== undefined) { setCode(""); setStepUp(result.error.stepUp); } else setErrorKey("errors.generic");
          return;
        }
        setErrorKey(errorKeyFor(result.error.code, "otp"));
        return;
      }
      await services.tokens.save(result.value.tokens);
      const isNew = result.value.isNewAccount && !isSignInOnly();
      setNewAccountSignUp(isNew);
      if (!isNew) {
        // Existing member: no age step, no consents step (their server-side choices stand). Straight to the merge.
        try { await services.markOnboardingDone(); } catch { /* the welcome screen marks it again */ }
        services.session.phoneE164 = null;
        services.session.pendingDob = null;
        setSignInOnly(false);
        router.replace(peekReturnTarget() !== null ? "/sign-up?phase=merge" : "/onboarding/welcome");
        return;
      }
      const dob = services.session.pendingDob;
      if (dob === null) {
        // The date lived in memory only and the app restarted: ask again rather than trust nothing.
        router.replace("/onboarding/account");
        return;
      }
      const age = await services.api.submitAge({ dob, attestedAtLeast18: true });
      if (!age.ok) {
        if (age.error.code === "age_not_eligible") {
          await services.tokens.clear();
          await wipeGuestData(getGuestStore(), services.storage); // E9: store and size profile
          services.session.pendingDob = null;
          router.replace("/onboarding/blocked");
          return;
        }
        setErrorKey(errorKeyFor(age.error.code));
        return;
      }
      services.session.pendingDob = null;
      await services.setResume("consents");
      router.replace("/onboarding/consents");
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await services.api.requestOtp({
        phoneE164: phone,
        locale: i18n.language === "en" ? "en" : "ar",
        idempotencyKey: randomUrlSafeId(24),
      });
      if (!result.ok) {
        setErrorKey(errorKeyFor(result.error.code));
        return;
      }
      services.session.sendsSoFar = result.value.sendsSoFar;
      services.session.lastSentAtMs = services.clock.now().getTime();
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  if (stepUp !== null) {
    return (
      <StepScaffold step="otp" title={t("stepUp.title")} body="">
        <StepUpPanel
          challenge={stepUp}
          onSignedIn={async () => {
            setNewAccountSignUp(false);
            services.session.phoneE164 = null;
            services.session.pendingDob = null;
            setSignInOnly(false);
            router.replace(peekReturnTarget() !== null ? "/sign-up?phase=merge" : "/onboarding/welcome");
          }}
          onLeave={() => { setSignInOnly(false); router.replace("/(tabs)/bag"); }}
        />
      </StepScaffold>
    );
  }

  return (
    <StepScaffold step="otp" title={t("onboarding.otp.title")} body={t("onboarding.otp.body", { phone: maskPhone(phone) })}>
      <TestId id="otp-input"><TextField
        label={t("onboarding.otp.label")}
        value={code}
        onChangeText={(v) => setCode(sanitizeOtp(v))}
        keyboardType="numeric"
        {...(errorKey !== null ? { error: t(errorKey) } : {})}
      /></TestId>
      {noAccount ? (
        <>
          <Banner tone="info" message={t("checkoutGate.noAccount")} />
          <Button title={t("checkoutGate.createInstead")} variant="ghost" onPress={() => { setSignInOnly(false); router.replace("/onboarding/account"); }} />
        </>
      ) : null}
      <Button variant="brand" testID="otp-verify" title={t("onboarding.otp.verify")} onPress={() => void verify()} loading={busy} />
      <Ticker nowFn={nowFn} render={(nowMs) => {
        const remaining = resendRemainingSeconds(services.session.sendsSoFar, services.session.lastSentAtMs, nowMs);
        const exhausted = resendExhausted(services.session.sendsSoFar) && remaining === 0;
        return (
          <>
            {remaining > 0 ? <Text secondary>{t("onboarding.otp.resendIn", { seconds: remaining })}</Text> : null}
            {exhausted ? <Text secondary>{t("onboarding.otp.resendExhausted")}</Text> : null}
            {remaining === 0 && !exhausted ? (
              <Button title={t("onboarding.otp.resend")} variant="ghost" onPress={() => void resend()} disabled={busy} />
            ) : null}
          </>
        );
      }} />
      <Button title={t("onboarding.otp.changeNumber")} variant="ghost" onPress={() => router.replace("/onboarding/account")} />
    </StepScaffold>
  );
}
