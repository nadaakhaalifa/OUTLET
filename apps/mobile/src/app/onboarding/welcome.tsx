import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui";
import { StepScaffold } from "../../components/Scaffold";
import { useServices } from "../../state/services";

export default function WelcomeStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const start = async () => {
    try {
      await services.markOnboardingDone();
    } catch {
      // Not persisted: onboarding would show again next launch, which is safe.
    }
    router.replace("/(tabs)");
  };
  return (
    <StepScaffold step="done" title={t("onboarding.welcome.title")} body={t("onboarding.welcome.body")}>
      <Button title={t("onboarding.welcome.start")} onPress={() => void start()} />
    </StepScaffold>
  );
}
