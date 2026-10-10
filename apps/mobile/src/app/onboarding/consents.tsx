import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Button, Card, SwitchRow, Text } from "../../ui";
import { StepScaffold } from "../../components/Scaffold";
import { CONSENT_PURPOSES, defaultConsentView, type ConsentPurpose } from "../../workspace";
import { useServices } from "../../state/services";

export default function ConsentsStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  // Nothing pre-ticked: initial state comes from the privacy package's all-false default.
  const [selection, setSelection] = useState<Record<ConsentPurpose, boolean>>({ ...defaultConsentView() });
  const [busy, setBusy] = useState(false);

  const finish = async (skipped: boolean) => {
    setBusy(true);
    try {
      await services.consent.saveOnboardingChoices(skipped ? {} : selection);
      // Analytics starts (via the consent subscription) only if its own purpose was granted above.
      await services.analytics.trackOnboardingStep("consents", skipped);
      router.replace("/onboarding/welcome");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScaffold step="consents" title={t("onboarding.consents.title")} body={t("onboarding.consents.body")}>
      <View style={{ gap: spacing.md }}>
        {CONSENT_PURPOSES.map((purpose) => (
          <Card key={purpose}>
            <SwitchRow
              label={t(`consent.purposes.${purpose}.title`)}
              value={selection[purpose]}
              onValueChange={(v) => setSelection((s) => ({ ...s, [purpose]: v }))}
              disabled={busy}
            />
            <Text variant="caption" secondary>{t(`consent.purposes.${purpose}.description`)}</Text>
          </Card>
        ))}
      </View>
      <Button title={t("onboarding.consents.save")} onPress={() => void finish(false)} loading={busy} />
      <Button title={t("common.skip")} variant="secondary" onPress={() => void finish(true)} disabled={busy} />
      <Text variant="caption" secondary>{t("onboarding.consents.skipNote")}</Text>
    </StepScaffold>
  );
}
