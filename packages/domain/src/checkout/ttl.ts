import { DEFAULT_TTL_POLICIES } from "../inventory/ttl-policy";
import type { PaymentMethod as InventoryMethod } from "../inventory/types";
import type { CheckoutMethod } from "./types";

const MAP: Readonly<Record<CheckoutMethod, InventoryMethod>> = {
  card: "CARD",
  apple_pay: "APPLE_PAY",
  meeza: "MEEZA",
  mobile_wallet: "WALLET",
  instapay: "INSTAPAY",
  fawry: "FAWRY",
  bnpl: "BNPL",
  cod: "COD",
};

export const inventoryMethodFor = (m: CheckoutMethod): InventoryMethod => MAP[m];

/** Reservation window by payment method (ADR-0011 defaults: 10 min cards, 30 min wallets, 24 h Fawry). */
export function reservationTtlSeconds(m: CheckoutMethod): number {
  const policy = DEFAULT_TTL_POLICIES.find((p) => p.paymentMethod === MAP[m]);
  if (policy === undefined) throw new Error(`no TTL policy for ${m}`);
  return policy.ttlSeconds;
}
