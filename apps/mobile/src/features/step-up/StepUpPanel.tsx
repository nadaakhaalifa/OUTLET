import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import type { StepUpChallenge } from "../../api/port";
import { Banner, Button, Text } from "../../ui";
import { useServices } from "../../state/services";
import { getPasskeyAssertion, runStepUp } from "./model";

/** "Confirm it's you" (M-SU-1) and the contact-support state (M-SU-2). Calls onSignedIn after tokens are saved. */
export function StepUpPanel({ challenge, onSignedIn, onLeave }: {
  readonly challenge: StepUpChallenge;
  readonly onSignedIn: () => void | Promise<void>;
  readonly onLeave: () => void;
}) {
  const { t } = useTranslation();
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [support, setSupport] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const out = await runStepUp({
        passkey: getPasskeyAssertion(),
        assertPasskey: (i) => services.api.assertPasskey(i),
        save: (tk) => services.tokens.save(tk),
        markOnboardingDone: () => services.markOnboardingDone(),
        nowMs: () => services.clock.now().getTime(),
      }, challenge);
      if (out.kind === "signed_in") { await onSignedIn(); return; }
      if (out.kind === "contact_support") { setSupport(true); return; }
      setErrorKey(out.errorKey);
    } catch {
      setErrorKey("errors.generic");
    } finally {
      setBusy(false);
    }
  };

  if (support) {
    return (
      <View style={{ gap: spacing.md }} testID="stepup-support">
        <Text variant="title1" accessibilityRole="header">{t("stepUp.supportTitle")}</Text>
        <Text variant="body" secondary>{t("stepUp.supportBody")}</Text>
        <Button variant="brand" testID="stepup-support-back" title={t("stepUp.backToShopping")} onPress={onLeave} />
      </View>
    );
  }
  return (
    <View style={{ gap: spacing.md }} testID="stepup-confirm">
      <Text variant="title1" accessibilityRole="header">{t("stepUp.title")}</Text>
      <Text variant="body" secondary>{t("stepUp.body")}</Text>
      {errorKey !== null ? <Banner tone="error" message={t(errorKey)} /> : null}
      <Button variant="brand" testID="stepup-passkey" title={t("stepUp.usePasskey")} onPress={() => void run()} loading={busy} disabled={busy} />
      <Button variant="ghost" testID="stepup-no-passkey" title={t("stepUp.noPasskey")} onPress={() => setSupport(true)} disabled={busy} />
    </View>
  );
}
