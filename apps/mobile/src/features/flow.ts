/**
 * Onboarding flow (spec 1, B6). One "account" screen holds the date of birth + 18+ attestation, terms and the phone number;
 * the age gate runs before any phone number is used. The language is taken from the device, and preference steps
 * (vibes, sizes, brands, budget, notifications) are optional and live outside this funnel.
 */
export const ONBOARDING_STEPS = ["account", "otp", "consents", "done"] as const;
/** "language" is an optional, off-funnel step (language is taken from the device); it stays valid for analytics and its screen. */
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number] | "language";

export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ["language", "consents"];

export function isSkippable(step: OnboardingStep): boolean {
  return SKIPPABLE_STEPS.includes(step);
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step as (typeof ONBOARDING_STEPS)[number]);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)] ?? "done";
}

/** 1-based position among the visible steps (done is not counted). */
export function stepProgress(step: OnboardingStep): { readonly current: number; readonly total: number } {
  const total = ONBOARDING_STEPS.length - 1;
  return { current: Math.min(Math.max(ONBOARDING_STEPS.indexOf(step as (typeof ONBOARDING_STEPS)[number]), 0) + 1, total), total };
}

export type AnalyticsStep = "auth" | "age_attestation" | "language" | "consents";

/** Maps a step to the analytics catalog's onboarding step; `null` means the step is not tracked. */
export function analyticsStepFor(step: OnboardingStep): AnalyticsStep | null {
  switch (step) {
    case "otp":
      return "auth";
    case "account":
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
  account: "/onboarding/account",
  otp: "/onboarding/otp",
  language: "/onboarding/language",
  consents: "/onboarding/consents",
  done: "/(tabs)",
};

// ---- Checkout gate return target (ADR-0055, spec F3) ----
/** Checkout step 1 (Delivery, ADR-0053): where a shopper resumes after signing up at the Checkout gate. */
export const CHECKOUT_STEP_ONE = "/checkout";

let returnTarget: string | null = null;

/** Set when the Checkout gate opens; read by the merge step. Memory only: a killed app simply starts again from the Bag. */
export function setReturnTarget(href: string | null): void {
  returnTarget = href;
}
export function peekReturnTarget(): string | null {
  return returnTarget;
}
/** Reads and clears. */
export function takeReturnTarget(): string | null {
  const t = returnTarget;
  returnTarget = null;
  return t;
}

// ---- Sign-in inside the Checkout gate ----
let signInOnly = false;
/** True while the gate's "Already have an account? Sign in" toggle is on: the OTP step must never create an account. */
export function setSignInOnly(v: boolean): void { signInOnly = v; }
export function isSignInOnly(): boolean { return signInOnly; }

// ---- Which kind of account the gate just produced ----
let newAccountSignUp = false;
/** True only after an OTP that created a brand-new account: device guest consent decisions may then be flushed. Memory only; default false is the safe side. */
export function setNewAccountSignUp(v: boolean): void { newAccountSignUp = v; }
export function isNewAccountSignUp(): boolean { return newAccountSignUp; }
