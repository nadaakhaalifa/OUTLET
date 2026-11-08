import { add, allocate, money, percentOf, sub } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { SplitInstruction } from "../ports.js";
import { SellerNetError } from "./errors.js";
import type { StoreQuote } from "./types.js";

/** Everything the ledger entry, the seller order row and the PSP split need for one store (README section 8). */
export interface SellerAmounts {
  readonly storeId: string;
  readonly items: Money;
  readonly shipping: Money;
  readonly shippingVat: Money;
  readonly shippingNet: Money;
  readonly goodsVat: Money;
  readonly commissionBp: number;
  readonly commission: Money;
  readonly commissionVat: Money;
  /** I13 residual: items - commission - commission VAT. */
  readonly net: Money;
  /** What the shopper owes this seller order: items + delivery - platform - seller discounts. */
  readonly total: Money;
  /** Platform-funded discount (goods + delivery): the ledger debits promo_expense_platform for it (chart 4.2). */
  readonly platformDiscount: Money;
  /** Seller-funded discount (goods + delivery): only shrinks the seller's share (chart 4.2). */
  readonly sellerDiscount: Money;
}

export function sellerAmounts(store: StoreQuote, commissionBp: number, commissionVatBp: number): SellerAmounts {
  if (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10_000) throw new RangeError("commission bp must be an integer in 0..10000");
  const items = store.itemsSubtotal;
  // ledger chart 4.2 / V60: the commission base is the goods after SELLER-funded discounts and before platform-funded ones.
  // A seller-funded delivery waiver is not commissionable; it comes off the seller's residual so the platform still earns the full delivery fee.
  const sellerGoods = store.lines.reduce((a, l) => add(a, l.sellerDiscount), money(0n, items.currency));
  const sellerShipping = store.shippingDiscount.seller;
  const base = sub(items, sellerGoods);
  const commission = percentOf(base, BigInt(commissionBp));
  const commissionVat = percentOf(commission, BigInt(commissionVatBp));
  const net = sub(sub(sub(base, commission), commissionVat), sellerShipping);
  if (net.amountMinor < 0n) throw new SellerNetError(store.storeId, net.amountMinor);
  const shippingVat = store.shipping.vat;
  return {
    storeId: store.storeId, items, shipping: store.shipping.gross, shippingVat, shippingNet: sub(store.shipping.gross, shippingVat),
    goodsVat: sub(store.vat, shippingVat), commissionBp, commission, commissionVat, net, total: store.total,
    platformDiscount: store.platformDiscount, sellerDiscount: store.sellerDiscount,
  };
}

/**
 * Split model A (D5): one instruction per seller order, summing exactly to the EXTERNAL amount. Each store's share of the external
 * amount is its total (largest remainder, so it is exact when no credit is used); the seller gets min(net, share), the platform the rest
 * (commission + commission VAT + delivery). With store credit the platform absorbs the credit first. VERIFY V4/V41.
 */
export function splitInstructions(
  sellers: readonly SellerAmounts[], external: Money, sellerOrderIds: ReadonlyMap<string, string>, subMerchants: ReadonlyMap<string, string | null>,
): SplitInstruction[] {
  const shares = allocate(external, sellers.map((s) => s.total.amountMinor));
  return sellers.map((s, i) => {
    const share = shares[i] ?? money(0n, external.currency);
    const sellerAmount = s.net.amountMinor < share.amountMinor ? s.net : share;
    return {
      sellerOrderId: sellerOrderIds.get(s.storeId) ?? "", storeId: s.storeId, subMerchantRef: subMerchants.get(s.storeId) ?? null,
      sellerAmount, platformAmount: sub(share, sellerAmount),
    };
  });
}
