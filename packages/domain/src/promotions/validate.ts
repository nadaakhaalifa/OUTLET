import { PAYMENT_METHODS, PROMOTION_KINDS, PROMOTION_SCOPES, PROMOTION_STATUSES, type Promotion } from "./types";

const CODE = /^[A-Z0-9_-]{3,40}$/;
const SCOPES_BY_KIND: Readonly<Record<Promotion["value"]["kind"], readonly string[]>> = {
  percent: ["item", "store", "order"],
  fixed: ["item", "store", "order"],
  bogo: ["item"],
  tiered: ["store", "order"],
  free_shipping: ["shipping"],
};

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const isInt = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;

/** Returns machine-readable issues; empty means the definition is well formed. */
export function validatePromotion(p: Promotion): string[] {
  const issues: string[] = [];
  const bad = (code: string): void => {
    issues.push(code);
  };
  if (!isInt(p.version, 1, 1_000_000)) bad("version_invalid");
  if (!PROMOTION_KINDS.includes(p.value.kind)) bad("kind_unsupported");
  if (!PROMOTION_SCOPES.includes(p.scope)) bad("scope_invalid");
  else if (!SCOPES_BY_KIND[p.value.kind].includes(p.scope)) bad("scope_not_allowed_for_kind");
  if (!PROMOTION_STATUSES.includes(p.status)) bad("status_invalid");

  const f = p.funding;
  if (!isInt(f.platformPct, 0, 100) || !isInt(f.sellerPct, 0, 100) || f.platformPct + f.sellerPct !== 100) {
    bad("funding_must_sum_to_100");
  }
  if (p.owner.kind === "store") {
    if (f.platformPct !== 0) bad("seller_promotion_cannot_be_platform_funded");
    const ids = p.targeting.storeIds;
    if (ids.some((id) => id !== (p.owner.kind === "store" ? p.owner.storeId : ""))) bad("seller_promotion_store_scope");
  }

  if ((p.code === null) === !p.autoApply) bad("code_xor_auto_apply");
  if (p.code !== null && !CODE.test(p.code)) bad("code_format");

  const v = p.value;
  switch (v.kind) {
    case "percent":
      if (!isInt(v.percentBps, 1, 10_000)) bad("percent_bps_range");
      break;
    case "fixed":
      if (v.amount.amount <= 0n || v.amount.currency !== "EGP") bad("fixed_amount_invalid");
      break;
    case "bogo":
      if (!isInt(v.buyQty, 1, 100) || !isInt(v.getQty, 1, 100)) bad("bogo_qty_range");
      if (!isInt(v.getPercentBps, 1, 10_000)) bad("bogo_percent_bps_range");
      break;
    case "tiered": {
      if (v.tiers.length === 0 || v.tiers.length > 10) bad("tiers_count");
      let prevMin = 0n;
      let prevBps = 0;
      for (const t of v.tiers) {
        if (t.minSubtotal.amount <= prevMin || !isInt(t.percentBps, 1, 10_000) || t.percentBps < prevBps) {
          bad("tiers_not_ascending");
          break;
        }
        prevMin = t.minSubtotal.amount;
        prevBps = t.percentBps;
      }
      break;
    }
    case "free_shipping":
      break;
  }

  for (const m of p.targeting.paymentMethods) if (!PAYMENT_METHODS.includes(m)) bad("payment_method_invalid");
  for (const [name, m] of [
    ["min_order", p.minOrder],
    ["max_discount", p.maxDiscount],
    ["total_budget", p.totalBudget],
  ] as const) {
    if (m !== null && (m.amount <= 0n || m.currency !== "EGP")) bad(`${name}_invalid`);
  }
  if (p.perUserCap !== null && !isInt(p.perUserCap, 1, 1_000_000)) bad("per_user_cap_invalid");
  if (p.perDayCap !== null && !isInt(p.perDayCap, 1, 1_000_000)) bad("per_day_cap_invalid");
  if (!Number.isFinite(p.startsAtMs) || !Number.isFinite(p.endsAtMs) || p.endsAtMs <= p.startsAtMs) {
    bad("window_invalid");
  }
  return issues;
}
