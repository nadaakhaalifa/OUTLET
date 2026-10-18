export type RiskDecision = "allow" | "require_otp" | "require_prepayment" | "prepaid_only" | "limit_value" | "block";
export type BudgetDecision = "within" | "soft_cap_exceeded" | "hard_cap_exceeded";
export type TokenState = "valid" | "expired" | "not_found" | "not_card";

/** Everything re-read at charge time (spec Rules, "At charge time recheck"). */
export interface ChargeFacts {
  readonly nowMs: number;
  readonly mandateExpiresAtMs: number;
  readonly mandateArmed: boolean;
  readonly maxPrice: bigint;
  /** The verified price the shopper was notified of. The charge never exceeds it (spec: flap above skips). */
  readonly triggerPrice: bigint;
  readonly price: bigint;
  readonly priceVerified: boolean;
  readonly priceAnomaly: boolean;
  readonly listed: boolean;
  readonly sizeInStock: boolean;
  readonly deliverable: boolean;
  readonly budget: BudgetDecision;
  readonly risk: RiskDecision;
  readonly token: TokenState;
  readonly plusActive: boolean;
  readonly ageOk: boolean;
  readonly units: number;
}

export type ChargeSkipReason =
  | "mandate_not_armed"
  | "mandate_expired"
  | "plus_lapsed"
  | "age_restricted"
  | "price_above_max"
  | "price_above_notified"
  | "price_not_verified"
  | "price_anomaly"
  | "sku_unlisted"
  | "out_of_stock"
  | "not_deliverable"
  | "budget_cap"
  | "risk_not_allowed"
  | "token_invalid"
  | "units_exceeded";

export type ChargeDecision =
  | { readonly kind: "charge"; readonly amount: bigint }
  | { readonly kind: "skip"; readonly reason: ChargeSkipReason };

/**
 * The single place that decides whether money may move. Fail closed: the first failed check wins
 * and the order of checks is part of the contract (cheap and absolute first). The amount is the
 * price at charge time, which by construction never exceeds min(max price, notified trigger price).
 */
export function decideCharge(f: ChargeFacts): ChargeDecision {
  const skip = (reason: ChargeSkipReason): ChargeDecision => ({ kind: "skip", reason });
  if (!f.mandateArmed) return skip("mandate_not_armed");
  if (f.nowMs >= f.mandateExpiresAtMs) return skip("mandate_expired");
  if (f.units !== 1) return skip("units_exceeded");
  if (!f.plusActive) return skip("plus_lapsed");
  if (!f.ageOk) return skip("age_restricted");
  if (f.token !== "valid") return skip("token_invalid");
  if (!f.listed) return skip("sku_unlisted");
  if (f.price <= 0n || f.price > f.maxPrice) return skip("price_above_max");
  if (f.price > f.triggerPrice) return skip("price_above_notified");
  if (!f.priceVerified) return skip("price_not_verified");
  if (f.priceAnomaly) return skip("price_anomaly");
  if (!f.sizeInStock) return skip("out_of_stock");
  if (!f.deliverable) return skip("not_deliverable");
  // Soft cap blocks too: the mandate carries no override, and a hold gesture needs the shopper.
  if (f.budget !== "within") return skip("budget_cap");
  if (f.risk !== "allow") return skip("risk_not_allowed");
  return { kind: "charge", amount: f.price };
}
