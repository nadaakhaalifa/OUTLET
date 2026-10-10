import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Checkbox, Text, TextField } from "../../ui";
import { StepScaffold } from "../../components/Scaffold";
import { errorKeyFor } from "../../features/api-errors";
import { assessAge } from "../../features/dob";
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

  const submit = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const deviceId = await services.installId();
      const existing = (await services.loadSoftBlock()) ?? undefined;
      const outcome = assessAge({ day, month, year }, attested, deviceId, existing, {
        hasher: sha256Hex,
        clock: services.clock,
      });
      switch (outcome.kind) {
        case "invalid_date":
          setErrorKey(day === "" || month === "" || year === "" ? "onboarding.dob.errorIncomplete" : "onboarding.dob.errorInvalid");
          return;
        case "needs_attestation":
          setErrorKey("onboarding.dob.errorAttest");
          return;
        case "blocked_under_18":
          // Keep only the hashed device block. Drop the half-created session; the DOB is never sent or stored.
          await services.saveSoftBlock(outcome.block);
          await services.tokens.clear();
          router.replace("/onboarding/blocked");
          return;
        case "blocked_device":
          await services.tokens.clear();
          router.replace("/onboarding/blocked");
          return;
        case "accepted": {
          const result = await services.api.submitAge({ dob: outcome.dob, attestedAtLeast18: true });
          if (!result.ok) {
            setErrorKey(errorKeyFor(result.error.code));
            return;
          }
          setLimited(outcome.limitedCapacity);
          await services.setResume("language");
          await services.analytics.trackOnboardingStep("dob", false);
          router.replace("/onboarding/language");
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
          <TextField label={t("onboarding.dob.day")} value={day} onChangeText={(v) => setDay(v.slice(0, 2))} keyboardType="numeric" />
        </View>
        <View style={{ flex: 1 }}>
          <TextField label={t("onboarding.dob.month")} value={month} onChangeText={(v) => setMonth(v.slice(0, 2))} keyboardType="numeric" />
        </View>
        <View style={{ flex: 1.4 }}>
          <TextField label={t("onboarding.dob.year")} value={year} onChangeText={(v) => setYear(v.slice(0, 4))} keyboardType="numeric" />
        </View>
      </View>
      {fieldError !== undefined ? <Banner tone="error" message={fieldError} /> : null}
      <Text variant="caption" secondary>{t("onboarding.dob.privacyNote")}</Text>
      <Checkbox label={t("onboarding.dob.attest")} value={attested} onValueChange={setAttested} />
      {errorKey === "onboarding.dob.errorAttest" ? <Banner tone="error" message={t(errorKey)} /> : null}
      {limited ? <Banner tone="info" message={t("onboarding.dob.limitedCapacity")} /> : null}
      <Button title={t("onboarding.dob.submit")} onPress={() => void submit()} loading={busy} />
    </StepScaffold>
  );
}
