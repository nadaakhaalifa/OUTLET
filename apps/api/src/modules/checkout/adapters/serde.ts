import { z } from "zod";
import { CHECKOUT_METHODS, type CheckoutQuote, type Money, type SagaFacts, type StoreCreditSub } from "../domain/bridge";
import type { ClientAction, StoredQuote } from "../domain/ports";

/** JSON that survives bigint: `{"$bigint":"123"}`. Never a JSON number (precision) and never a bare string (ambiguity). */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? { $bigint: x.toString() } : x));

const isTagged = (x: unknown): x is { $bigint: string } =>
  typeof x === "object" && x !== null && Object.keys(x).length === 1 && typeof (x as { $bigint?: unknown }).$bigint === "string";

export const fromJson = (raw: unknown): unknown =>
  JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw), (_k, x: unknown) => (isTagged(x) ? BigInt(x.$bigint) : x));

const Money_ = z.object({ amount: z.bigint(), currency: z.literal("EGP") }).strict() satisfies z.ZodType<Money>;
const Text = z.object({ ar: z.string(), en: z.string().optional() }).strict();
const Sub: z.ZodType<StoreCreditSub> = z.union([
  z.object({ kind: z.literal("refund_credit") }).strict(),
  z.object({ kind: z.literal("cashback_coins") }).strict(),
  z.object({ kind: z.literal("referral_credit") }).strict(),
  z.object({ kind: z.literal("goodwill") }).strict(),
  z.object({ kind: z.literal("gift_card"), cardId: z.string() }).strict(),
]);

const Status = z.enum([
  "VALIDATE_CART",
  "RESERVE_INVENTORY",
  "HOLD_CREDIT",
  "CREATE_INTENT",
  "AWAIT_PAYMENT",
  "CLAIM_AND_POST",
  "PLACED",
  "COMPENSATING",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "REFUNDED",
]);
const Terminal = z.enum(["FAILED", "EXPIRED", "CANCELLED", "REFUNDED"]);
const Reason = z.enum([
  "stock_unavailable",
  "payment_failed",
  "payment_window_elapsed",
  "cancelled_by_shopper",
  "price_changed",
  "late_payment_no_stock",
  "late_credit_unavailable",
  "payment_after_cancel",
  "risk_blocked",
  "intent_rejected",
  "credit_unavailable",
]);

export const FactsSchema: z.ZodType<SagaFacts> = z
  .object({
    status: Status,
    method: z.enum(CHECKOUT_METHODS),
    creditAmount: z.bigint(),
    externalDue: z.bigint(),
    codConfirmation: z.enum(["not_required", "pending", "confirmed"]),
    reservationId: z.string().nullable(),
    reservationExpiresAtMs: z.number().int().nullable(),
    reservationReleased: z.boolean(),
    holdId: z.string().nullable(),
    holdSeq: z.number().int().nonnegative(),
    holdReleased: z.boolean(),
    holdCaptured: z.boolean(),
    intentId: z.string().nullable(),
    intentVoided: z.boolean(),
    payment: z.enum(["none", "succeeded", "failed"]),
    claimed: z.boolean(),
    ledgerPosted: z.boolean(),
    ledgerReversed: z.boolean(),
    ordersPlaced: z.boolean(),
    refunded: z.boolean(),
    lateReceiptPosted: z.boolean(),
    compensating: z.object({ reason: Reason, terminal: Terminal }).strict().nullable(),
  })
  .strict();

const QuoteLine = z
  .object({
    lineId: z.string(),
    skuId: z.string(),
    productId: z.string(),
    storeId: z.string(),
    qty: z.number().int().positive(),
    unitPrice: Money_,
    discount: Money_,
    vat: Money_,
  })
  .strict();
const StoreQuote = z
  .object({
    storeId: z.string(),
    merchandise: Money_,
    platformFundedDiscount: Money_,
    sellerFundedDiscount: Money_,
    deliveryFee: Money_,
    shipping: Money_,
    freeDeliveryReason: z.enum(["plus", "threshold", "promotion", "none"]),
    vat: Money_,
    total: Money_,
  })
  .strict();
const QuoteSchema: z.ZodType<CheckoutQuote> = z
  .object({
    method: z.enum(CHECKOUT_METHODS),
    lines: z.array(QuoteLine),
    stores: z.array(StoreQuote),
    subtotal: Money_,
    discount: Money_,
    shipping: Money_,
    vat: Money_,
    total: Money_,
    tender: z
      .object({
        storeCredit: z.array(z.object({ sub: Sub, amount: Money_ }).strict()),
        storeCreditTotal: Money_,
        externalDue: Money_,
      })
      .strict(),
    vatBps: z.bigint(),
  })
  .strict();

const StoredShape = z
  .object({
    quote: QuoteSchema,
    lines: z.array(
      z
        .object({
          lineId: z.string(),
          skuId: z.string(),
          productId: z.string(),
          storeId: z.string(),
          qty: z.number().int().positive(),
          unitPrice: Money_,
          discount: Money_,
          vat: Money_,
          title: Text,
          sizeLabel: z.string().optional(),
        })
        .strict(),
    ),
    commissionBps: z.record(z.string(), z.number().int().min(0).max(10_000)),
    buyer: z
      .object({
        firstName: z.string().nullable(),
        phoneRelay: z.string().nullable(),
        governorateCode: z.string(),
      })
      .strict(),
    addressId: z.string().nullable(),
    lockExpiresAtMs: z.number().int().optional(),
  })
  .strict();

/** Zod's optional is `T | undefined`; with exactOptionalPropertyTypes the stored shape omits the key instead. */
export const StoredSchema = StoredShape as unknown as z.ZodType<StoredQuote>;

export const ClientActionSchema: z.ZodType<ClientAction> = z.union([
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("redirect"), url: z.string() }).strict(),
  z.object({ type: z.literal("sdk"), sdk: z.string(), token: z.string() }).strict(),
  z.object({ type: z.literal("fawry_reference"), reference: z.string(), expiresAtMs: z.number().int() }).strict(),
  z.object({ type: z.literal("await_confirmation"), channel: z.enum(["otp", "whatsapp"]) }).strict(),
]);
