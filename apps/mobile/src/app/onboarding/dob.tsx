import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Checkbox, Text, TextField } from "../../ui";
import { TestId } from "../../components/TestId";
import { StepScaffold } from "../../components/Scaffold";
import { errorKeyFor } from "../../features/api-errors";
import { ageGateErrorKey, runAgeGate } from "../../features/age-gate";
import { sha256Hex } from "../../workspace";
import { useServices } from "../../state/services";

export default function DobStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [attested, setAttested] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const deviceId = await services.installId();
      const outcome = await runAgeGate({ day, month, year }, attested, deviceId, {
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
            await services.setResume("language");
            await services.analytics.trackOnboardingStep("dob", false);
            router.replace("/onboarding/language");
            return;
          }
          // First pass: keep the date in memory only; it is sent once after the phone is verified.
          services.session.pendingDob = outcome.dob;
          await services.setResume("phone");
          await services.analytics.trackOnboardingStep("dob", false);
          router.replace("/onboarding/phone");
          return;
        }
      }
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  const fieldError = errorKey !== null && errorKey !== "onboarding.dob.errorAttest" ? t(errorKey) : undefined;

  return (
    <StepScaffold step="dob" title={t("onboarding.dob.title")} body={t("onboarding.dob.body")}>
      {/* Order is day, month, year in both languages; the row follows layout direction. */}
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <TestId id="dob-day"><TextField label={t("onboarding.dob.day")} value={day} onChangeText={(v) => setDay(v.slice(0, 2))} keyboardType="numeric" /></TestId>
        </View>
        <View style={{ flex: 1 }}>
          <TestId id="dob-month"><TextField label={t("onboarding.dob.month")} value={month} onChangeText={(v) => setMonth(v.slice(0, 2))} keyboardType="numeric" /></TestId>
        </View>
        <View style={{ flex: 1.4 }}>
          <TestId id="dob-year"><TextField label={t("onboarding.dob.year")} value={year} onChangeText={(v) => setYear(v.slice(0, 4))} keyboardType="numeric" /></TestId>
        </View>
      </View>
      {fieldError !== undefined ? <Banner tone="error" message={fieldError} /> : null}
      <Text variant="caption" secondary>{t("onboarding.dob.privacyNote")}</Text>
      <TestId id="dob-attest"><Checkbox label={t("onboarding.dob.attest")} value={attested} onValueChange={setAttested} /></TestId>
      {errorKey === "onboarding.dob.errorAttest" ? <Banner tone="error" message={t(errorKey)} /> : null}
      {limited ? <Banner tone="info" message={t("onboarding.dob.limitedCapacity")} /> : null}
      {busy ? <Text variant="caption" secondary>{t("onboarding.dob.checking")}</Text> : null}
      <Button
        title={offline ? t("common.retry") : t("onboarding.dob.submit")}
        onPress={() => void submit()}
        loading={busy}
        disabled={busy}
      />
    </StepScaffold>
  );
}
