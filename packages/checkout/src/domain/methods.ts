import type { CheckoutConfig, ExternalMethod, HoldWindow, PaymentMethod } from "../ports.js";

/** Kill-switch key per method (packages/flags). A killed method is absent from the quote and refused by place(). */
export const KILL_SWITCH_OF: Readonly<Record<PaymentMethod, string>> = {
  card: "payments.card.enabled",
  apple_pay: "payments.apple_pay.enabled",
  meeza: "payments.meeza.enabled",
  wallet: "payments.mobile_wallet.enabled",
  instapay: "payments.instapay.enabled",
  fawry: "payments.fawry.enabled",
  bnpl: "payments.bnpl.enabled",
  cod: "payments.cod.enabled",
  store_credit: "payments.store_credit.enabled",
};

export const isExternal = (m: PaymentMethod): m is ExternalMethod => m !== "cod" && m !== "store_credit";

export const holdWindowOf = (config: CheckoutConfig, m: PaymentMethod): HoldWindow => config.methodWindow[m];
export const holdSecondsOf = (config: CheckoutConfig, m: PaymentMethod): number => config.holdWindowSec[config.methodWindow[m]];

export const secondsToMs = (s: number): number => s * 1000;
