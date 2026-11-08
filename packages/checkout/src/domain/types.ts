/**
 * Domain contracts for the pure quote and the price-lock comparison (README sections 4 and 5).
 * Types only; the builder implements `quote()` and `compareLock()` in src/domain/quote.ts and src/domain/price-lock.ts.
 */
import type { Money } from "@outlet/money";
import type { PaymentMethod } from "../ports.js";

/** One purchasable bag line, already joined with live price, VRP snapshot and tax rate. */
export interface QuoteLineInput {
  readonly cartLineId: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money; // live, VAT-inclusive
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly conditionGrade: string;
  readonly defectCardId: string | null;
  readonly vrp: Money | null; // PriceSnapshotService.snapshotForOrderLine
  readonly claimType: "verified_discount" | "lowest_30d" | "launch_price" | "plain";
  readonly evidenceIds: readonly string[];
  readonly taxCategory: "standard" | "zero_rated" | "exempt" | "reduced";
  readonly vatBp: number;
}

export interface QuoteInput {
  readonly marketId: string;
  readonly currency: Money["currency"];
  readonly lines: readonly QuoteLineInput[];
  /** One VAT-inclusive delivery fee per store (one shipment per seller order in Phase 1), from ShippingQuotePort. */
  readonly shipping: ReadonlyMap<string, { readonly fee: Money; readonly quoteRef: string; readonly etaDaysMin: number; readonly etaDaysMax: number }>;
  /** Methods not killed (kill switches, fail closed) and allowed for this shopper; each with its configured fee. */
  readonly methods: ReadonlyMap<PaymentMethod, { readonly fee: Money }>;
  /** Spendable store credit (0 when the store_credit kill switch is engaged). */
  readonly creditAvailable: Money;
  readonly creditRequested: Money;
  readonly shippingTaxBp: number;
  /** Promotions are not built: always zero in this step. */
  readonly discount: Money;
}

export interface QuoteLine {
  readonly cartLineId: string;
  readonly skuId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly lineGross: Money;
  readonly vat: Money; // VAT included in lineGross (splitInclusive, computed once per line)
  readonly vatBp: number;
  readonly taxCategory: QuoteLineInput["taxCategory"];
  readonly vrp: Money | null;
  readonly claimType: QuoteLineInput["claimType"];
  /** (vrp - unitPrice) * qty only when claimType = verified_discount and vrp > unitPrice; else zero. */
  readonly verifiedSaving: Money;
}

export interface StoreQuote {
  readonly storeId: string;
  readonly lines: readonly QuoteLine[];
  readonly itemsSubtotal: Money;
  readonly shipping: { readonly gross: Money; readonly vat: Money; readonly quoteRef: string; readonly etaDaysMin: number; readonly etaDaysMax: number };
  readonly vat: Money; // goods VAT + delivery VAT
  readonly total: Money;
}

/** Every fee that can apply, present on the first render (no drip pricing): delivery per store and every method fee. */
export interface Fee {
  readonly code: "delivery" | "payment_method";
  readonly storeId: string | null;
  readonly method: PaymentMethod | null;
  readonly amount: Money;
}

export interface Quote {
  readonly stores: readonly StoreQuote[];
  readonly fees: readonly Fee[];
  readonly itemsSubtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly vat: Money;
  /** Merchandise + delivery - discount, before method fee and store credit. */
  readonly total: Money;
  readonly storeCredit: Money; // min(requested, available, total)
  /** What the shopper pays externally for each available method: total + method fee - store credit. */
  readonly payableByMethod: ReadonlyMap<PaymentMethod, Money>;
  /** "You saved X": sum of verifiedSaving only. Never from vouchers, never from unverified references. */
  readonly verifiedSavings: Money;
  /** sha256 over the canonical serialisation of everything above; the quote token signs it. */
  readonly hash: string;
}

/** Result of re-quoting at commit against the signed quote (price-lock). Empty list = unchanged. */
export type PriceDelta =
  | { readonly kind: "line_price"; readonly skuId: string; readonly before: Money; readonly after: Money }
  | { readonly kind: "line_unavailable"; readonly skuId: string }
  | { readonly kind: "line_added"; readonly skuId: string }
  | { readonly kind: "shipping"; readonly storeId: string; readonly before: Money; readonly after: Money }
  | { readonly kind: "method_fee"; readonly method: PaymentMethod; readonly before: Money; readonly after: Money }
  | { readonly kind: "store_credit"; readonly before: Money; readonly after: Money }
  | { readonly kind: "total"; readonly before: Money; readonly after: Money };
