import { percentOf, type Money } from "@outlet/money";
import type { TaxRate } from "./rates.js";
import { TaxError } from "./rates.js";
import { addExclusive, splitInclusive, type VatSplit } from "./vat.js";

export interface CommissionInvoiceLine extends VatSplit {
  readonly kind: "commission";
  readonly sellerOrderId: string;
  readonly vatBps: number;
  readonly commissionBps: number;
}
export interface B2cSupplyLine extends VatSplit {
  readonly kind: "delivery_fee";
  readonly ref: string;
  readonly vatBps: number;
}

/** B2B ETA e-invoice line to the seller. The commission base (V60) is decided by the caller; VAT is computed once on the commission. */
export function commissionInvoiceLines(
  sellerOrder: { readonly id: string; readonly commissionBase: Money },
  commissionBps: number,
  vatRate: TaxRate,
): CommissionInvoiceLine[] {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new TaxError("INVALID_RATE", "commissionBps must be an integer in 0..10000");
  }
  const commission = percentOf(sellerOrder.commissionBase, BigInt(commissionBps));
  return [
    { kind: "commission", sellerOrderId: sellerOrder.id, vatBps: vatRate.bps, commissionBps, ...addExclusive(commission, vatRate.bps) },
  ];
}

/** B2C e-receipt lines for our own supplies (delivery fees we charge, VAT-inclusive). Goods are the seller's supply (B4). */
export function ourB2cSupplies(
  orderGroup: { readonly id: string; readonly deliveryFees: readonly { readonly ref: string; readonly gross: Money }[] },
  vatRate: TaxRate,
): B2cSupplyLine[] {
  return orderGroup.deliveryFees
    .filter((f) => f.gross.amountMinor > 0n)
    .map((f) => ({ kind: "delivery_fee", ref: `${orderGroup.id}:${f.ref}`, vatBps: vatRate.bps, ...splitInclusive(f.gross, vatRate.bps) }));
}
