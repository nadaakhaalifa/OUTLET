import { canonical } from "@outlet/checkout";
import type { PaymentMethod, Quote, QuoteResult } from "@outlet/checkout";
import { moneySchema } from "@outlet/money";
import { z } from "zod";
import { wireMoney } from "../../platform/money-wire.js";

/**
 * The quote is pure and stored nowhere, so the client echoes it at placement and the server trusts it only if its canonical hash equals the
 * signed token's (checkout README section 5). `quoteEcho` is the canonical JSON of the whole quote (bigint as strings, Map as sorted pairs);
 * `readEcho` parses it back. A tampered echo changes the hash and placement answers 422 `quote-token-invalid`.
 */
export const quoteEcho = (q: Quote): unknown => JSON.parse(canonical(q));

const Money = moneySchema;
const Method = z.enum(["card", "apple_pay", "meeza", "wallet", "instapay", "fawry", "bnpl", "cod", "store_credit"]);
const QuoteLine = z.object({
  cartLineId: z.string(), skuId: z.string(), storeId: z.string(), qty: z.number().int(), unitPrice: Money, lineGross: Money, vat: Money, vatBp: z.number().int(),
  platformDiscount: Money, sellerDiscount: Money, payable: Money,
  taxCategory: z.enum(["standard", "zero_rated", "exempt", "reduced"]), vrp: Money.nullable(), claimType: z.enum(["verified_discount", "lowest_30d", "launch_price", "plain"]), verifiedSaving: Money,
});
const StoreQuote = z.object({
  storeId: z.string(), lines: z.array(QuoteLine).max(50), itemsSubtotal: Money,
  shipping: z.object({ gross: Money, vat: Money, quoteRef: z.string(), etaDaysMin: z.number().int(), etaDaysMax: z.number().int() }), vat: Money, total: Money,
  shippingDiscount: z.object({ platform: Money, seller: Money }), platformDiscount: Money, sellerDiscount: Money,
});
const PromotionRef = z.object({ promotionId: z.string(), version: z.number().int(), voucherId: z.string().nullable(), total: Money, platform: Money, seller: Money });
const DiscountLabel = z.object({ promotionId: z.string(), kind: z.enum(["voucher", "discount"]), textAr: z.string(), textEn: z.string(), amount: Money });
const EchoSchema = z.object({
  stores: z.array(StoreQuote).max(50),
  fees: z.array(z.object({ code: z.enum(["delivery", "payment_method"]), storeId: z.string().nullable(), method: Method.nullable(), amount: Money })).max(200),
  itemsSubtotal: Money, shipping: Money, discount: Money, vat: Money, total: Money, storeCredit: Money,
  promotions: z.array(PromotionRef).max(100), discountLabels: z.array(DiscountLabel).max(100),
  payableByMethod: z.array(z.tuple([Method, Money])).max(20).transform((pairs) => new Map(pairs)),
  verifiedSavings: Money, hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const readEcho = (raw: unknown): Quote | null => {
  const r = EchoSchema.safeParse(raw);
  return r.success ? (r.data) : null;
};

const CONTRACT_METHOD: Readonly<Record<PaymentMethod, string>> = { card: "card", apple_pay: "apple_pay", meeza: "meeza", wallet: "mobile_wallet", instapay: "instapay", fawry: "fawry", bnpl: "bnpl", cod: "cod", store_credit: "store_credit" };
export const toInternalMethod = (m: string): PaymentMethod => (m === "mobile_wallet" ? "wallet" : (m as PaymentMethod));
export const toContractMethod = (m: PaymentMethod): string => CONTRACT_METHOD[m];

export const wireQuote = (r: QuoteResult): Record<string, unknown> => {
  const q = r.quote;
  return {
    quote_token: r.token,
    expires_at: r.expiresAt.toISOString(),
    currency: q.total.currency,
    stores: q.stores.map((s) => ({
      store_id: s.storeId,
      items_subtotal: wireMoney(s.itemsSubtotal),
      shipping: wireMoney(s.shipping.gross),
      parcels: [{ store_id: s.storeId, quote_ref: s.shipping.quoteRef, fee: wireMoney(s.shipping.gross), days_min: s.shipping.etaDaysMin, days_max: s.shipping.etaDaysMax }],
    })),
    items_subtotal: wireMoney(q.itemsSubtotal),
    discount: wireMoney(q.discount),
    shipping: wireMoney(q.shipping),
    vat_included: wireMoney(q.vat),
    store_credit: wireMoney(q.storeCredit),
    total: wireMoney(q.total),
    verified_savings: wireMoney(q.verifiedSavings),
    fees: q.fees.map((f) => ({ code: f.code === "delivery" ? `delivery:${f.storeId ?? ""}` : `payment_method:${f.method ?? ""}`, amount: wireMoney(f.amount) })),
    payment_options: [...q.payableByMethod.entries()].map(([method, payable]) => ({ method: toContractMethod(method), available: true, payable: wireMoney(payable) })),
    cod_allowed: r.cod.allowed,
    cod_reason_code: r.cod.reasonCode,
    notices: r.unavailableSkus.map(() => ({ code: "unavailable", line_id: null })),
    invalid_voucher_codes: [...r.invalidVoucherCodes],
    discount_labels: q.discountLabels.map((l) => ({ promotion_id: l.promotionId, kind: l.kind, text_ar: l.textAr, text_en: l.textEn, amount: wireMoney(l.amount) })),
    quote_echo: quoteEcho(q),
  };
};
