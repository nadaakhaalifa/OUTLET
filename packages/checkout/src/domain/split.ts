import { allocate, money, percentOf, sub } from "@outlet/money";
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
  readonly total: Money;
}

export function sellerAmounts(store: StoreQuote, commissionBp: number, commissionVatBp: number): SellerAmounts {
  if (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10_000) throw new RangeError("commission bp must be an integer in 0..10000");
  const items = store.itemsSubtotal;
  const commission = percentOf(items, BigInt(commissionBp));
  const commissionVat = percentOf(commission, BigInt(commissionVatBp));
  const net = sub(sub(items, commission), commissionVat);
  if (net.amountMinor < 0n) throw new SellerNetError(store.storeId, net.amountMinor);
  const shippingVat = store.shipping.vat;
  return {
    storeId: store.storeId, items, shipping: store.shipping.gross, shippingVat, shippingNet: sub(store.shipping.gross, shippingVat),
    goodsVat: sub(store.vat, shippingVat), commissionBp, commission, commissionVat, net, total: store.total,
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
