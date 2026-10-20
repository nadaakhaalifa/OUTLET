import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import type { Locale } from "@outlet/i18n";
import { Button, Text } from "../../ui";
import { StepScaffold } from "../../components/Scaffold";
import { applyLanguage } from "../../i18n";
import { useServices } from "../../state/services";

export default function LanguageStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [busy, setBusy] = useState(false);

  const skip = async () => {
    await services.analytics.trackOnboardingStep("language", true);
    await services.setResume("consents");
    router.replace("/onboarding/consents");
  };

  const choose = async (locale: Locale) => {
    setBusy(true);
    try {
      await services.analytics.trackOnboardingStep("language", false);
      // Set the resume marker first: a direction change reloads the app and resumes at the next step.
      await services.setResume("consents");
      const outcome = await applyLanguage(locale, services.storage);
      if (outcome !== "reloading") router.replace("/onboarding/consents");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScaffold step="language" art="eid" title={t("onboarding.language.title")} body={t("onboarding.language.body")}>
      <Button title={t("language.arabic")} onPress={() => void choose("ar")} loading={busy} />
      <Button title={t("language.english")} variant="secondary" onPress={() => void choose("en")} disabled={busy} />
      <Text variant="caption" secondary>{t("onboarding.language.note")}</Text>
      <Button title={t("common.skip")} variant="ghost" onPress={() => void skip()} disabled={busy} />
    </StepScaffold>
  );
}
