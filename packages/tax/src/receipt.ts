import { add, sub, type Money } from "@outlet/money";
import type { AllocatedLine } from "./allocate.js";
import type { B2cSupplyLine } from "./invoices.js";
import { TaxError } from "./rates.js";
import { zero } from "./vat.js";

export type ReceiptLine =
  | { readonly kind: "item"; readonly id: string; readonly gross: Money; readonly vat: Money; readonly net: Money }
  | { readonly kind: "delivery_fee"; readonly ref: string; readonly gross: Money; readonly vat: Money; readonly net: Money }
  /** "voucher -X" (V62 / CPL): a discount line, never a reference price or a strike-through. `amount` is positive; render it as a deduction. */
  | { readonly kind: "discount"; readonly funder: "platform" | "seller"; readonly amount: Money };

export interface Receipt {
  readonly lines: readonly ReceiptLine[];
  readonly gross: Money;
  readonly discount: Money;
  /** paid total = gross - discount on every document */
  readonly paidTotal: Money;
}

/**
 * Shopper document: item lines at their full gross, delivery fees, then one discount line per funder, so
 * paidTotal === gross - discount. Throws if it disagrees with the allocation's cash figure (payable + fees).
 */
export function buildReceipt(input: { readonly items: readonly AllocatedLine[]; readonly deliveryFees?: readonly B2cSupplyLine[] }, currency: Money["currency"] = "EGP"): Receipt {
  const fees = input.deliveryFees ?? [];
  const lines: ReceiptLine[] = [
    ...input.items.map((l): ReceiptLine => ({ kind: "item", id: l.id, gross: add(l.payable, l.discount), vat: l.vat, net: l.net })),
    ...fees.map((f): ReceiptLine => ({ kind: "delivery_fee", ref: f.ref, gross: f.gross, vat: f.vat, net: f.net })),
  ];
  const platform = input.items.reduce((a, l) => add(a, l.platformDiscount), zero(currency));
  const seller = input.items.reduce((a, l) => add(a, l.sellerDiscount), zero(currency));
  if (seller.amountMinor > 0n) lines.push({ kind: "discount", funder: "seller", amount: seller });
  if (platform.amountMinor > 0n) lines.push({ kind: "discount", funder: "platform", amount: platform });
  const gross = lines.reduce((a, l) => (l.kind === "discount" ? a : add(a, l.gross)), zero(currency));
  const discount = add(platform, seller);
  const paidTotal = sub(gross, discount);
  const cash = [...input.items.map((l) => l.payable), ...fees.map((f) => f.gross)].reduce((a, m) => add(a, m), zero(currency));
  if (paidTotal.amountMinor !== cash.amountMinor) throw new TaxError("INVALID_INPUT", "receipt total disagrees with the allocated payable total");
  return { lines, gross, discount, paidTotal };
}
