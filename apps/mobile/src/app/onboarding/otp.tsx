import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, Text, TextField } from "../../ui";
import { TestId } from "../../components/TestId";
import { StepScaffold } from "../../components/Scaffold";
import { errorKeyFor } from "../../features/api-errors";
import { isCompleteOtp, resendExhausted, resendRemainingSeconds, sanitizeOtp } from "../../features/otp";
import { maskPhone } from "../../features/phone";
import { randomUrlSafeId } from "../../platform/random";
import { useServices } from "../../state/services";

export default function OtpStep() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const phone = services.session.phoneE164;
  const [code, setCode] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(() =>
    resendRemainingSeconds(services.session.sendsSoFar, services.session.lastSentAtMs, services.clock.now().getTime()),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(
        resendRemainingSeconds(services.session.sendsSoFar, services.session.lastSentAtMs, services.clock.now().getTime()),
      );
    }, 1000);
    return () => clearInterval(id);
  }, [services]);

  useEffect(() => {
    if (phone === null) router.replace("/onboarding/phone");
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
      const result = await services.api.verifyOtp({ phoneE164: phone, code });
      if (!result.ok) {
        setErrorKey(errorKeyFor(result.error.code, "otp"));
        return;
      }
      await services.tokens.save(result.value.tokens);
      const dob = services.session.pendingDob;
      if (dob === null) {
        // The date lived in memory only and the app restarted: ask again rather than trust nothing.
        router.replace("/onboarding/dob");
        return;
      }
      const age = await services.api.submitAge({ dob, attestedAtLeast18: true });
      if (!age.ok) {
        if (age.error.code === "age_not_eligible") {
          await services.tokens.clear();
          services.session.pendingDob = null;
          router.replace("/onboarding/blocked");
          return;
        }
        setErrorKey(errorKeyFor(age.error.code));
        return;
      }
      services.session.pendingDob = null;
      await services.setResume("language");
      router.replace("/onboarding/language");
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
      setRemaining(resendRemainingSeconds(services.session.sendsSoFar, services.session.lastSentAtMs, services.clock.now().getTime()));
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const exhausted = resendExhausted(services.session.sendsSoFar) && remaining === 0;

  return (
    <StepScaffold step="otp" title={t("onboarding.otp.title")} body={t("onboarding.otp.body", { phone: maskPhone(phone) })}>
      <TestId id="otp-input"><TextField
        label={t("onboarding.otp.label")}
        value={code}
        onChangeText={(v) => setCode(sanitizeOtp(v))}
        keyboardType="numeric"
        {...(errorKey !== null ? { error: t(errorKey) } : {})}
      /></TestId>
      <Button title={t("onboarding.otp.verify")} onPress={() => void verify()} loading={busy} />
      {remaining > 0 ? <Text secondary>{t("onboarding.otp.resendIn", { seconds: remaining })}</Text> : null}
      {exhausted ? <Text secondary>{t("onboarding.otp.resendExhausted")}</Text> : null}
      {remaining === 0 && !exhausted ? (
        <Button title={t("onboarding.otp.resend")} variant="secondary" onPress={() => void resend()} disabled={busy} />
      ) : null}
      <Button title={t("onboarding.otp.changeNumber")} variant="secondary" onPress={() => router.replace("/onboarding/phone")} />
    </StepScaffold>
  );
}
