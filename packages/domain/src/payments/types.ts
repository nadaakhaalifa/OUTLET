/** Payments domain vocabulary (spec 7, B8, 15.6). Pure: no IO, no clock, no crypto. */

export const PAYMENT_METHOD_IDS = ["card", "meeza", "apple_pay", "mobile_wallet", "instapay", "fawry"] as const;
export type PaymentMethodId = (typeof PAYMENT_METHOD_IDS)[number];

/** Method families that have a kill switch in packages/feature-flags (`kill.payment.<family>`). */
export type KillSwitchFamily = "card" | "apple_pay" | "mobile_wallet" | "instapay" | "fawry";

export const PAYMENT_CURRENCY = "EGP" as const;

/** Provider ids are lowercase snake identifiers, never user input. */
export type ProviderId = string;
const PROVIDER_ID = /^[a-z][a-z0-9_]{1,31}$/;
export const isProviderId = (v: string): boolean => PROVIDER_ID.test(v);

export const isPaymentMethodId = (v: string): v is PaymentMethodId =>
  (PAYMENT_METHOD_IDS as readonly string[]).includes(v);
