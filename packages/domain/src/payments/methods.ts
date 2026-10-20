import type { KillSwitchFamily, PaymentMethodId } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PaymentMethodMeta {
  readonly id: PaymentMethodId;
  readonly killSwitch: KillSwitchFamily;
  /** How long the shopper has to complete payment; the stock reservation is held for the same window (spec 7 Rules). */
  readonly paymentWindowMs: number;
  /** Fawry: the reference code expires; other methods have no PSP-side expiry we rely on. */
  readonly referenceExpiresInMs: number | null;
  /** Drop SKUs are excluded from long-hold methods (spec 7: "drop SKUs are excluded from Fawry"). */
  readonly dropSkusAllowed: boolean;
  /** Stock pool the reservation draws from: Fawry uses a separate non-drop pool. */
  readonly stockPool: "standard" | "non_drop";
  readonly asynchronous: boolean;
}

export const PAYMENT_METHOD_META: Readonly<Record<PaymentMethodId, PaymentMethodMeta>> = {
  card: { id: "card", killSwitch: "card", paymentWindowMs: 10 * MIN, referenceExpiresInMs: null, dropSkusAllowed: true, stockPool: "standard", asynchronous: false },
  meeza: { id: "meeza", killSwitch: "card", paymentWindowMs: 10 * MIN, referenceExpiresInMs: null, dropSkusAllowed: true, stockPool: "standard", asynchronous: false },
  apple_pay: { id: "apple_pay", killSwitch: "apple_pay", paymentWindowMs: 10 * MIN, referenceExpiresInMs: null, dropSkusAllowed: true, stockPool: "standard", asynchronous: false },
  mobile_wallet: { id: "mobile_wallet", killSwitch: "mobile_wallet", paymentWindowMs: 30 * MIN, referenceExpiresInMs: null, dropSkusAllowed: true, stockPool: "standard", asynchronous: true },
  instapay: { id: "instapay", killSwitch: "instapay", paymentWindowMs: 30 * MIN, referenceExpiresInMs: null, dropSkusAllowed: true, stockPool: "standard", asynchronous: true },
  fawry: { id: "fawry", killSwitch: "fawry", paymentWindowMs: 24 * HOUR, referenceExpiresInMs: 24 * HOUR, dropSkusAllowed: false, stockPool: "non_drop", asynchronous: true },
};

export type MethodUnavailableReason = "kill_switch" | "drop_sku_not_allowed" | "no_provider" | "amount_out_of_range";
