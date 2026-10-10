import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Banner, Screen, Text } from "../ui";
import { stepProgress, type OnboardingStep } from "../features/flow";

/** Common chrome for onboarding steps: progress, title, body, and the dev-fixture notice. */
export function StepScaffold(props: { step: OnboardingStep; title: string; body?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const p = stepProgress(props.step);
  return (
    <Screen>
      <Text variant="caption" secondary>{t("onboarding.progress", { current: p.current, total: p.total })}</Text>
      <Text variant="title">{props.title}</Text>
      {props.body !== undefined ? <Text secondary>{props.body}</Text> : null}
      {props.children}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
