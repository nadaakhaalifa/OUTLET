/** Onboarding flow (spec 1, B6). Everything after the DOB step is skippable. */
export const ONBOARDING_STEPS = ["phone", "otp", "dob", "language", "consents", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ["language", "consents"];

export function isSkippable(step: OnboardingStep): boolean {
  return SKIPPABLE_STEPS.includes(step);
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)] ?? "done";
}

/** 1-based position among the visible steps (done is not counted). */
export function stepProgress(step: OnboardingStep): { readonly current: number; readonly total: number } {
  const total = ONBOARDING_STEPS.length - 1;
  return { current: Math.min(ONBOARDING_STEPS.indexOf(step) + 1, total), total };
}

export type AnalyticsStep = "auth" | "age_attestation" | "language" | "consents";

/** Maps a step to the analytics catalog's onboarding step; `null` means the step is not tracked. */
export function analyticsStepFor(step: OnboardingStep): AnalyticsStep | null {
  switch (step) {
    case "phone":
    case "otp":
      return "auth";
    case "dob":
      return "age_attestation";
    case "language":
      return "language";
    case "consents":
      return "consents";
    case "done":
      return null;
  }
}

export const ROUTE_FOR_STEP: Readonly<Record<OnboardingStep, string>> = {
  phone: "/onboarding/phone",
  otp: "/onboarding/otp",
  dob: "/onboarding/dob",
  language: "/onboarding/language",
  consents: "/onboarding/consents",
  done: "/(tabs)",
};
