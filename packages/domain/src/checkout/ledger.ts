import { chart, type StoreCreditSub } from "../chart-of-accounts/accounts";
import { orderRecognised, type EntryMeta, type Tender } from "../chart-of-accounts/builders";
import { createJournalEntry, type JournalEntry } from "../ledger";
import { money, type Money } from "../money";
import { InvalidCheckoutError } from "./errors";
import type { CheckoutQuote } from "./types";

export interface CheckoutLedgerInput {
  readonly quote: CheckoutQuote;
  readonly userId: string;
  /** PSP (or BNPL provider) that collected the external portion. Null when nothing is external. */
  readonly provider: string | null;
  /** Commission rate snapshot per store, basis points. */
  readonly commissionBps: ReadonlyMap<string, number>;
}

/**
 * THE single source of the order-recognition idempotency key (R-1). Checkout posts its prepaid
 * recognition entry under `order_paid:{g}`, fulfillment posts COD recognition under
 * `order_cod_confirmed:{g}` at delivered_at, and refunds require one of the two. These are exactly
 * the ledger-posting template keys (asserted in a test), so the spec'd template key is the live one.
 */
export type RecognitionMode = "prepaid" | "cod";
export function orderRecognitionKey(orderGroupId: string, mode: RecognitionMode): string {
  return mode === "cod" ? `order_cod_confirmed:${orderGroupId}` : `order_paid:${orderGroupId}`;
}
/** Every key under which an order of this group may have been recognised (refund guard). */
export function orderRecognitionKeys(orderGroupId: string): readonly string[] {
  return [orderRecognitionKey(orderGroupId, "prepaid"), orderRecognitionKey(orderGroupId, "cod")];
}

/** Fail closed: a store with no commission snapshot must stop the entry, never post it at 0%. */
function commissionFor(map: ReadonlyMap<string, number>, storeId: string): bigint {
  const bps = map.get(storeId);
  if (bps === undefined || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new InvalidCheckoutError(`commission missing or invalid for store ${storeId}`);
  }
  return BigInt(bps);
}

/**
 * The OrderRecognised entry for a prepaid checkout, posted when payment is confirmed (ADR-0021).
 * Cash on delivery returns null: it is recognised at delivery and courier remittance, not here.
 */
export function checkoutOrderEntry(input: CheckoutLedgerInput, meta: EntryMeta): JournalEntry | null {
  const { quote } = input;
  if (quote.method === "cod") return null;
  const tenders: Tender[] = quote.tender.storeCredit.map((c) => ({
    kind: "store_credit" as const,
    userId: input.userId,
    sub: c.sub as StoreCreditSub,
    amount: c.amount,
  }));
  if (quote.tender.externalDue.amount > 0n) {
    if (input.provider === null) throw new InvalidCheckoutError("external amount without a provider");
    tenders.push(
      quote.method === "bnpl"
        ? { kind: "bnpl", provider: input.provider, amount: quote.tender.externalDue }
        : { kind: "psp", psp: input.provider, amount: quote.tender.externalDue },
    );
  }
  return orderRecognised(
    {
      sellerOrders: quote.stores.map((s) => ({
        storeId: s.storeId,
        merchandise: s.merchandise,
        commissionBps: commissionFor(input.commissionBps, s.storeId),
        platformFundedDiscount: s.platformFundedDiscount,
        sellerFundedDiscount: s.sellerFundedDiscount,
      })),
      shippingGross: quote.shipping,
      vatBps: quote.vatBps,
      tenders,
    },
    meta,
  );
}

/**
 * Money that arrived for an order that can no longer be fulfilled is parked in refund_reserve so
 * the PSP clearing balance and the ledger agree until the refund leaves (VERIFY: chart status of
 * refund_reserve is "reserved", this use needs the owner's confirmation).
 */
export function lateReceiptEntry(amount: Money, psp: string, meta: EntryMeta): JournalEntry {
  if (amount.amount <= 0n) throw new InvalidCheckoutError("receipt must be positive");
  return createJournalEntry({
    ...meta,
    kind: "late_receipt_parked",
    postings: [
      { account: chart.pspClearing(psp), amount },
      { account: chart.refundReserve, amount: money(-amount.amount) },
    ],
  });
}

export function lateRefundEntry(amount: Money, psp: string, meta: EntryMeta): JournalEntry {
  if (amount.amount <= 0n) throw new InvalidCheckoutError("refund must be positive");
  return createJournalEntry({
    ...meta,
    kind: "late_receipt_refunded",
    postings: [
      { account: chart.refundReserve, amount },
      { account: chart.pspClearing(psp), amount: money(-amount.amount) },
    ],
  });
}
