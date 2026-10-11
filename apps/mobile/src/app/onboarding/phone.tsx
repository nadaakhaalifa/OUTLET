import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, TextField } from "../../ui";
import { TestId } from "../../components/TestId";
import { StepScaffold } from "../../components/Scaffold";
import { errorKeyFor } from "../../features/api-errors";
import { normalizeEgyptianPhone } from "../../features/phone";
import { randomUrlSafeId } from "../../platform/random";
import { useServices } from "../../state/services";

export default function PhoneStep() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [raw, setRaw] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The age gate comes first. Without an accepted date of birth in this session, go back to it.
  useEffect(() => {
    if (services.session.pendingDob === null) {
      void services.getResume().then(
        (r) => {
          if (r !== "phone") router.replace("/onboarding/dob");
        },
        () => router.replace("/onboarding/dob"),
      );
    }
  }, [router, services]);

  const send = async () => {
    const phone = normalizeEgyptianPhone(raw);
    if (!phone.ok) {
      setErrorKey(
        phone.reason === "empty"
          ? "onboarding.phone.errorEmpty"
          : phone.reason === "country_not_supported"
            ? "onboarding.phone.errorCountry"
            : "onboarding.phone.errorInvalid",
      );
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await services.api.requestOtp({
        phoneE164: phone.e164,
        locale: i18n.language === "en" ? "en" : "ar",
        idempotencyKey: randomUrlSafeId(24),
      });
      if (!result.ok) {
        setErrorKey(errorKeyFor(result.error.code));
        return;
      }
      services.session.phoneE164 = phone.e164;
      services.session.sendsSoFar = result.value.sendsSoFar;
      services.session.lastSentAtMs = services.clock.now().getTime();
      router.push("/onboarding/otp");
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScaffold step="phone" title={t("onboarding.phone.title")} body={t("onboarding.phone.body")}>
      <TestId id="phone-input"><TextField
        label={t("onboarding.phone.label")}
        value={raw}
        onChangeText={setRaw}
        placeholder={t("onboarding.phone.placeholder")}
        helper={t("onboarding.phone.helper")}
        keyboardType="phone-pad"
        {...(errorKey !== null ? { error: t(errorKey) } : {})}
      /></TestId>
      <Button title={t("onboarding.phone.send")} onPress={() => void send()} loading={busy} />
    </StepScaffold>
  );
}
