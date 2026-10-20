import { describe, expect, it } from "vitest";
import { money } from "../money";
import { S1, S2, egp, promo } from "./fixtures";
import { normalizeCode, validatePromotion } from "./validate";

describe("validatePromotion", () => {
  it("accepts a well formed promotion", () => {
    expect(validatePromotion(promo({ code: "SAVE10" }))).toEqual([]);
  });
  it("normalises codes", () => {
    expect(normalizeCode("  save10 ")).toBe("SAVE10");
  });
  it("funding must sum to 100 and sellers cannot be platform funded", () => {
    expect(validatePromotion(promo({ funding: { platformPct: 60, sellerPct: 60 } }))).toContain("funding_must_sum_to_100");
    expect(validatePromotion(promo({ funding: { platformPct: 50.5, sellerPct: 49.5 } }))).toContain("funding_must_sum_to_100");
    const s = promo({ owner: { kind: "store", storeId: S1 }, funding: { platformPct: 50, sellerPct: 50 } });
    expect(validatePromotion(s)).toContain("seller_promotion_cannot_be_platform_funded");
    const other = promo({
      owner: { kind: "store", storeId: S1 },
      funding: { platformPct: 0, sellerPct: 100 },
      targeting: { storeIds: [S2], skuIds: [], paymentMethods: [], plusOnly: false },
    });
    expect(validatePromotion(other)).toContain("seller_promotion_store_scope");
  });
  it("needs exactly one of code and auto apply", () => {
    expect(validatePromotion(promo({ code: null, autoApply: false }))).toContain("code_xor_auto_apply");
    expect(validatePromotion(promo({ code: "ABC", autoApply: true }))).toContain("code_xor_auto_apply");
    expect(validatePromotion(promo({ code: "a b" }))).toContain("code_format");
    expect(validatePromotion(promo({ code: null, autoApply: true }))).toEqual([]);
  });
  it("checks scope per kind", () => {
    expect(validatePromotion(promo({ scope: "shipping" }))).toContain("scope_not_allowed_for_kind");
    expect(
      validatePromotion(promo({ scope: "order", value: { kind: "bogo", buyQty: 1, getQty: 1, getPercentBps: 10_000 } })),
    ).toContain("scope_not_allowed_for_kind");
    expect(validatePromotion(promo({ scope: "item", value: { kind: "tiered", tiers: [{ minSubtotal: egp(1n), percentBps: 100 }] } }))).toContain(
      "scope_not_allowed_for_kind",
    );
  });
  it("checks values", () => {
    expect(validatePromotion(promo({ value: { kind: "percent", percentBps: 0 } }))).toContain("percent_bps_range");
    expect(validatePromotion(promo({ value: { kind: "percent", percentBps: 10_001 } }))).toContain("percent_bps_range");
    expect(validatePromotion(promo({ value: { kind: "percent", percentBps: 10_000 } }))).toEqual([]);
    expect(validatePromotion(promo({ value: { kind: "fixed", amount: money(0n) } }))).toContain("fixed_amount_invalid");
    expect(
      validatePromotion(promo({ scope: "item", value: { kind: "bogo", buyQty: 0, getQty: 1, getPercentBps: 100 } })),
    ).toContain("bogo_qty_range");
    expect(
      validatePromotion(promo({ scope: "item", value: { kind: "bogo", buyQty: 1, getQty: 1, getPercentBps: 0 } })),
    ).toContain("bogo_percent_bps_range");
    expect(validatePromotion(promo({ value: { kind: "tiered", tiers: [] } }))).toContain("tiers_count");
    expect(
      validatePromotion(
        promo({
          value: {
            kind: "tiered",
            tiers: [
              { minSubtotal: egp(10n), percentBps: 500 },
              { minSubtotal: egp(5n), percentBps: 600 },
            ],
          },
        }),
      ),
    ).toContain("tiers_not_ascending");
    expect(
      validatePromotion(
        promo({
          value: {
            kind: "tiered",
            tiers: [
              { minSubtotal: egp(5n), percentBps: 600 },
              { minSubtotal: egp(10n), percentBps: 500 },
            ],
          },
        }),
      ),
    ).toContain("tiers_not_ascending");
  });
  it("checks caps, money and window", () => {
    expect(validatePromotion(promo({ perUserCap: 0 }))).toContain("per_user_cap_invalid");
    expect(validatePromotion(promo({ perDayCap: 1.5 }))).toContain("per_day_cap_invalid");
    expect(validatePromotion(promo({ minOrder: money(0n) }))).toContain("min_order_invalid");
    expect(validatePromotion(promo({ maxDiscount: money(-1n) }))).toContain("max_discount_invalid");
    expect(validatePromotion(promo({ totalBudget: money(0n) }))).toContain("total_budget_invalid");
    expect(validatePromotion(promo({ startsAtMs: 10, endsAtMs: 10 }))).toContain("window_invalid");
    expect(validatePromotion(promo({ version: 0 }))).toContain("version_invalid");
  });
});
