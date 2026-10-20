import { z } from "zod";

/** Consent purposes, exactly as listed in spec §B1 (`consent_records.purpose`). */
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

export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);
export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;

/**
 * The purpose an event needs before it may leave the device or service.
 * `strictly_necessary` means no consent is required (spec §26: "strictly-necessary
 * server events are pseudonymous"). It is only valid for server-origin events.
 */
export const STRICTLY_NECESSARY = "strictly_necessary" as const;
export type EventPurpose = ConsentPurpose | typeof STRICTLY_NECESSARY;

/** Where the event is produced. A client tracker may never emit a server-origin event. */
export type EventOrigin = "client" | "server";

/** Port: answers whether the current subject has granted a purpose right now. Never cached by the tracker. */
export interface ConsentChecker {
  isGranted(purpose: ConsentPurpose): boolean;
}
