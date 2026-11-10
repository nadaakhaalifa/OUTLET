import { z } from "zod";

/** Master prompt B1 consent purposes. Closed list: adding one needs a migration CHECK change too. */
export const CONSENT_PURPOSES = [
  "marketing_push",
  "marketing_whatsapp",
  "marketing_email",
  "analytics",
  "personalization",
  "budget_insights",
  "measurements",
  "location_precise",
  "cross_border_ml",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);

export const CONSENT_METHODS = ["banner", "onboarding", "settings", "api"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
