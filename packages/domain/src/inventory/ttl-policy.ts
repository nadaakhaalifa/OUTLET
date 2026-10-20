import type { HoldPoolKind, HoldReason, PaymentMethod } from "./types";

/**
 * Reservation TTL by payment method (ADR-0011). Configuration, not constants: the SQL table
 * `reservation_ttl_policies` carries the same rows and is versioned.
 */
export interface TtlPolicy {
  readonly id: string;
  readonly paymentMethod: PaymentMethod;
  readonly ttlSeconds: number;
  /** One extension on an active 3-DS challenge. 0 = none. */
  readonly extensionSeconds: number;
  readonly poolKind: HoldPoolKind;
  /** Cap per line for long-TTL pools, null = no cap beyond the bag rule. */
  readonly maxQtyPerLine: number | null;
  readonly version: number;
}

const p = (
  n: number,
  paymentMethod: PaymentMethod,
  ttlSeconds: number,
  extensionSeconds: number,
  poolKind: HoldPoolKind,
  maxQtyPerLine: number | null,
): TtlPolicy => ({
  id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, "0")}`,
  paymentMethod,
  ttlSeconds,
  extensionSeconds,
  poolKind,
  maxQtyPerLine,
  version: 1,
});

/**
 * Proposed defaults, ADR-0011 (status Proposed, owner approval pending; provider windows VR-04, VR-05).
 * Wallets and InstaPay hold on the STANDARD pool for 30 min. Only Fawry (24 h) uses the separate FAWRY pool.
 */
export const DEFAULT_TTL_POLICIES: readonly TtlPolicy[] = [
  p(1, "CARD", 600, 300, "STANDARD", null),
  p(2, "APPLE_PAY", 600, 300, "STANDARD", null),
  p(3, "MEEZA", 600, 300, "STANDARD", null),
  p(4, "COD", 600, 0, "STANDARD", null),
  p(5, "WALLET", 1800, 0, "STANDARD", null),
  p(6, "INSTAPAY", 1800, 0, "STANDARD", null),
  p(7, "BNPL", 900, 0, "STANDARD", null),
  p(8, "FAWRY", 86_400, 0, "FAWRY", 2),
];

export const holdReasonFor = (method: PaymentMethod): HoldReason => {
  switch (method) {
    case "CARD":
    case "APPLE_PAY":
    case "MEEZA":
      return "CARD_WINDOW";
    case "COD":
      return "COD";
    case "WALLET":
      return "WALLET_WINDOW";
    case "INSTAPAY":
      return "INSTAPAY_WINDOW";
    case "BNPL":
      return "BNPL_WINDOW";
    case "FAWRY":
      return "FAWRY_WINDOW";
  }
};

/** Highest version wins. Returns null when the method has no policy: the caller must fail closed. */
export const selectPolicy = (method: PaymentMethod, policies: readonly TtlPolicy[]): TtlPolicy | null => {
  let best: TtlPolicy | null = null;
  for (const policy of policies) {
    if (policy.paymentMethod !== method) continue;
    if (best === null || policy.version > best.version) best = policy;
  }
  return best;
};
