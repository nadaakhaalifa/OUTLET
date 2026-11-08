import { add, money } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { DiscountedTaxableLine } from "@outlet/tax";
import { lineGrossMinor } from "./evaluate.js";
import type { EvalBag, EvaluationResult } from "./types.js";

/** Per-line input for @outlet/tax allocateVatWithLineDiscounts: gross is the pre-discount VAT-inclusive line total. */
export const toTaxableLines = (bag: EvalBag, result: EvaluationResult): DiscountedTaxableLine[] => {
  const by = new Map(result.lines.map((l) => [l.lineId, l]));
  return bag.stores.flatMap((s) =>
    s.lines.map((l): DiscountedTaxableLine => {
      const r = by.get(l.id);
      return {
        id: l.id, bps: l.vatBp, gross: money(lineGrossMinor(l), bag.currency),
        platformDiscount: r?.platformDiscount ?? money(0n, bag.currency), sellerDiscount: r?.sellerDiscount ?? money(0n, bag.currency),
      };
    }),
  );
};

export interface StoreFunding {
  readonly storeId: string;
  readonly platformGoods: Money;
  readonly sellerGoods: Money;
  readonly platformShipping: Money;
  readonly sellerShipping: Money;
}
export interface LedgerFunding {
  /** Dr promo_expense_platform (ledger chart 4.2): every platform-funded minor unit, goods and shipping */
  readonly promoExpensePlatform: Money;
  /** seller-funded: no receivable and no platform account; it only shrinks the seller's share (4.2) */
  readonly sellerFunded: Money;
  readonly perStore: readonly StoreFunding[];
}

export const ledgerFunding = (bag: EvalBag, result: EvaluationResult): LedgerFunding => {
  const zero = money(0n, bag.currency);
  const lineStore = new Map(result.lines.map((l) => [l.lineId, l.storeId]));
  const perStore = bag.stores.map((s): StoreFunding => {
    let pg = zero; let sg = zero; let ps = zero; let ss = zero;
    for (const a of result.applied) {
      for (const d of a.lines) if (lineStore.get(d.lineId) === s.storeId) { pg = add(pg, d.platform); sg = add(sg, d.seller); }
      for (const d of a.shipping) if (d.storeId === s.storeId) { ps = add(ps, d.platform); ss = add(ss, d.seller); }
    }
    return { storeId: s.storeId, platformGoods: pg, sellerGoods: sg, platformShipping: ps, sellerShipping: ss };
  });
  return { promoExpensePlatform: result.totals.platformFunded, sellerFunded: result.totals.sellerFunded, perStore };
};
