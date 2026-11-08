import { accountCode } from "@outlet/ledger";
import type { JournalEntryDraft, PostingDraft } from "@outlet/ledger";
import { add, money, negate } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { SellerAmounts } from "./split.js";

export interface OrderPaidInput {
  readonly marketId: string;
  readonly currency: Money["currency"];
  readonly orderGroupId: string;
  readonly occurredAt: Date;
  /** Ledger owner of the clearing account (psp code, or bnpl provider). Must exist in the chart (seeded by migration). */
  readonly clearing: { readonly type: "psp_clearing" | "bnpl_clearing"; readonly owner: string };
  /** External tender captured by the PSP (0 for store-credit-only). */
  readonly external: Money;
  /** Captured store-credit holds (account code + amount). */
  readonly credit: readonly { readonly accountCode: string; readonly amount: Money }[];
  readonly sellers: readonly SellerAmounts[];
}

const acc = (m: string, c: Money["currency"], type: Parameters<typeof accountCode>[0]["type"], owner?: string): string =>
  accountCode({ type, market: m, currency: c, ...(owner === undefined ? {} : { owner }) });

/**
 * Ledger spec 4.1 / README section 8, one entry per order group, kind order_recognised, key order_paid:{group}.
 * Dr clearing (external) + Dr store_credit (holds) = Cr seller_pending (net) + commission_revenue + platform_vat_output
 * (commission VAT + delivery VAT) + shipping_revenue (delivery net). Zero postings are omitted (the ledger rejects them).
 */
export function orderPaidDraft(i: OrderPaidInput): JournalEntryDraft {
  const cur = i.currency;
  const sum = (xs: readonly Money[]): Money => xs.reduce((a, b) => add(a, b), money(0n, cur));
  const credits: PostingDraft[] = [];
  const pos = (code: string, amount: Money): void => {
    if (amount.amountMinor > 0n) credits.push({ accountCode: code, amount: negate(amount) });
  };
  for (const s of i.sellers) pos(acc(i.marketId, cur, "seller_pending", s.storeId), s.net);
  pos(acc(i.marketId, cur, "commission_revenue"), sum(i.sellers.map((s) => s.commission)));
  pos(acc(i.marketId, cur, "platform_vat_output"), add(sum(i.sellers.map((s) => s.commissionVat)), sum(i.sellers.map((s) => s.shippingVat))));
  pos(acc(i.marketId, cur, "shipping_revenue"), sum(i.sellers.map((s) => s.shippingNet)));
  const debits: PostingDraft[] = [];
  if (i.external.amountMinor > 0n) debits.push({ accountCode: acc(i.marketId, cur, i.clearing.type, i.clearing.owner), amount: i.external });
  for (const c of i.credit) if (c.amount.amountMinor > 0n) debits.push({ accountCode: c.accountCode, amount: c.amount });
  const dr = sum(debits.map((p) => p.amount));
  const cr = sum(credits.map((p) => negate(p.amount)));
  if (dr.amountMinor !== cr.amountMinor) throw new Error("order_paid entry does not balance (debits differ from credits)");
  return {
    kind: "order_recognised", idempotencyKey: `order_paid:${i.orderGroupId}`, marketId: i.marketId, occurredAt: i.occurredAt,
    ref: { type: "order_group", id: i.orderGroupId }, postings: [...debits, ...credits],
  };
}

/** Late payment with no stock: the money arrived and is owed back (README section 9; request R3 confirms the kind). */
export function lateRefundDraft(i: { readonly marketId: string; readonly currency: Money["currency"]; readonly orderGroupId: string; readonly occurredAt: Date; readonly clearingOwner: string; readonly external: Money }): JournalEntryDraft {
  return {
    kind: "refund_issued", idempotencyKey: `late_refund:${i.orderGroupId}`, marketId: i.marketId, occurredAt: i.occurredAt,
    ref: { type: "order_group", id: i.orderGroupId },
    postings: [
      { accountCode: acc(i.marketId, i.currency, "psp_clearing", i.clearingOwner), amount: i.external },
      { accountCode: acc(i.marketId, i.currency, "shopper_refunds_payable"), amount: negate(i.external) },
    ],
  };
}
