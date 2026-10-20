import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Button, Divider, SwitchRow, Text } from "../../ui";
import { StepScaffold } from "../../components/Scaffold";
import { CONSENT_PURPOSES, defaultConsentView, type ConsentPurpose } from "../../workspace";
import { peekReturnTarget, setSignInOnly } from "../../features/flow";
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
      // Signup is complete: the account exists, so the funnel is done. Preferences are optional and come later.
      try {
        await services.markOnboardingDone();
      } catch {
        // Not persisted: the welcome screen marks it again.
      }
      services.session.phoneE164 = null; // sign-up finished: the in-flight marker must not keep the create-account routes open
      setSignInOnly(false);
      // Signed up at the Checkout gate: merge the guest bag, then resume at checkout step 1 (ADR-0055).
      router.replace(peekReturnTarget() !== null ? "/sign-up?phase=merge" : "/onboarding/welcome");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScaffold step="consents" title={t("onboarding.consents.title")} body={t("onboarding.consents.body")}>
      <View>
        {CONSENT_PURPOSES.map((purpose, i) => (
          <View key={purpose} style={{ gap: spacing.xs, paddingBottom: spacing.md }}>
            {i > 0 ? <Divider style={{ marginBottom: spacing.sm }} /> : null}
            <SwitchRow
              label={t(`consent.purposes.${purpose}.title`)}
              value={selection[purpose]}
              onValueChange={(v) => setSelection((s) => ({ ...s, [purpose]: v }))}
              disabled={busy}
            />
            <Text variant="caption" secondary>{t(`consent.purposes.${purpose}.description`)}</Text>
          </View>
        ))}
      </View>
      <Button variant="brand" title={t("onboarding.consents.save")} onPress={() => void finish(false)} loading={busy} />
      <Button title={t("common.skip")} variant="ghost" onPress={() => void finish(true)} disabled={busy} />
      <Text variant="caption" secondary>{t("onboarding.consents.skipNote")}</Text>
    </StepScaffold>
  );
}
