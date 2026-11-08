import type { KillSwitchName } from "@outlet/flags";
import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { PromotionEvaluator, VoucherService, displayLabels } from "@outlet/promotions";
import type { AppliedPromotion, EvalBag, EvalContext, PromotionsDeps, QuoteEvaluation } from "@outlet/promotions";
import type { QuoteDiscounts, QuoteLineInput } from "../domain/types.js";
import type { PromotionsPort } from "../ports.js";
import type { Env } from "./env.js";

/** Typed against the flags registry: renaming the switch there breaks this line at compile time. */
export const PROMOTIONS_KILL_SWITCH = "promotions.enabled" satisfies KillSwitchName;

/** PromotionsPort over the real evaluator and voucher service (one PromotionsDeps, one client). */
export const makePromotionsPort = (deps: PromotionsDeps): PromotionsPort => {
  const evaluator = new PromotionEvaluator(deps);
  const vouchers = new VoucherService(deps);
  return {
    evaluateForQuote: (bag, ctx, opts) => evaluator.evaluateForQuote(bag, ctx, opts),
    reserve: (userId, groupId, applied) => vouchers.reserve(userId, groupId, applied),
    confirm: (userId, groupId) => vouchers.confirm(userId, groupId),
    release: (userId, groupId) => vouchers.release(userId, groupId),
  };
};

export interface PromotionOutcome { readonly discounts: QuoteDiscounts | null; readonly applied: readonly AppliedPromotion[]; readonly invalidCodes: readonly string[] }
const NONE: PromotionOutcome = { discounts: null, applied: [], invalidCodes: [] };

export const evalBagOf = (currency: Currency, lines: readonly QuoteLineInput[], shipping: ReadonlyMap<string, { readonly fee: Money }>): EvalBag => ({
  currency,
  stores: [...new Set(lines.map((l) => l.storeId))].sort().map((storeId) => ({
    storeId,
    shippingFeeMinor: shipping.get(storeId)?.fee.amountMinor ?? 0n,
    lines: lines.filter((l) => l.storeId === storeId).map((l) => ({ id: l.cartLineId, storeId, productId: l.productId, qty: l.qty, unitMinor: l.unitPrice.amountMinor, vatBp: l.vatBp })),
  })),
});

/**
 * Evaluates the promotions for a bag. Fails closed to "no discounts": kill switch engaged (flags registry name), no promotions port, or an
 * evaluator error. The context carries only order facts (first order, payment method); no budget, wellbeing or measurement data (master prompt 12, 17).
 */
export const evaluatePromotions = async (env: Env, bag: EvalBag, ctx: EvalContext, codes: readonly string[] | undefined): Promise<PromotionOutcome> => {
  if (env.promotions === undefined || (await env.killSwitches.isEngaged(PROMOTIONS_KILL_SWITCH))) return NONE;
  let ev;
  try {
    ev = await env.promotions.evaluateForQuote(bag, ctx, codes === undefined ? {} : { codes });
  } catch {
    return NONE;
  }
  if (ev.disabled) return NONE;
  return { applied: ev.result.applied.filter((a) => a.total.amountMinor > 0n), invalidCodes: ev.invalidCodes, discounts: toQuoteDiscounts(ev) };
};

/** Pure mapping from a promotion evaluation to what the quote consumes: per-line and per-store delivery amounts by funder, versions, labels. */
export const toQuoteDiscounts = (ev: QuoteEvaluation): QuoteDiscounts => {
  const cur = ev.result.currency;
  const zero = money(0n, cur);
  const lines = new Map(ev.result.lines.filter((l) => l.discount.amountMinor > 0n).map((l) => [l.lineId, { platform: l.platformDiscount, seller: l.sellerDiscount }] as const));
  const shipping = new Map<string, { platform: Money; seller: Money }>();
  for (const a of ev.result.applied) {
    for (const d of a.shipping) {
      const prev = shipping.get(d.storeId) ?? { platform: zero, seller: zero };
      shipping.set(d.storeId, { platform: money(prev.platform.amountMinor + d.platform.amountMinor, cur), seller: money(prev.seller.amountMinor + d.seller.amountMinor, cur) });
    }
  }
  const applied = ev.result.applied.filter((a) => a.total.amountMinor > 0n);
  return {
    lines, shipping,
    promotions: applied.map((a) => ({ promotionId: a.promotionId, version: a.version, voucherId: a.voucherId, total: a.total, platform: a.platform, seller: a.seller })),
    labels: displayLabels(ev.result).map((l) => ({ promotionId: l.promotionId, kind: l.kind, textAr: l.textAr, textEn: l.textEn, amount: l.amount })),
  };
};

/**
 * Settles the vouchers of a group AFTER the money transaction committed (VoucherService runs its own transaction). Both calls are idempotent;
 * a failure leaves the reservation counted against the caps (safe: never under-counts), so it is swallowed instead of failing a paid order.
 */
export const settleVouchers = async (env: Env, kind: "confirm" | "release", userId: string, groupId: string): Promise<void> => {
  if (env.promotions === undefined) return;
  try {
    await (kind === "confirm" ? env.promotions.confirm(userId, groupId) : env.promotions.release(userId, groupId));
  } catch {
    // reserved rows keep counting against the caps until a later confirm / release retry
  }
};
