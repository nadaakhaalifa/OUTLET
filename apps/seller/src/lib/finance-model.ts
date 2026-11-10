import { z } from "zod";
import { money, type Money } from "@outlet/money";

/** Wire shapes of GET /v1/{market}/seller/finance/* (the API validates its own responses; these guard the page against a drifting contract). */
const Amount = z.object({ amount_minor: z.string().regex(/^-?[0-9]{1,19}$/), currency: z.literal("EGP") });
export type Amount = z.infer<typeof Amount>;

export const PAYOUT_STATUSES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const Balance = z.object({
  pending: Amount, available: Amount, total: Amount, server_time: z.string(),
  payouts: z.object({ scheduled: Amount, held: Amount, in_transit: Amount, paid_to_date: Amount }),
});
export type Balance = z.infer<typeof Balance>;

const PayoutSummary = z.object({
  id: z.string(), status: z.enum(PAYOUT_STATUSES), cycle_start: z.string(), cycle_end: z.string(), gross: Amount, adjustments: Amount, net: Amount,
  created_at: z.string(), sent_at: z.string().nullable(), settled_at: z.string().nullable(),
});
export type PayoutSummary = z.infer<typeof PayoutSummary>;
export const PayoutPage = z.object({ items: z.array(PayoutSummary), next_cursor: z.string().nullable() });
export const PayoutDetail = PayoutSummary.extend({
  lines: z.array(z.object({ kind: z.enum(["order", "adjustment"]), seller_order_id: z.string().nullable(), amount: Amount })),
  lines_truncated: z.boolean(),
});
export type PayoutDetail = z.infer<typeof PayoutDetail>;

export const Statement = z.object({
  month: z.string(), period_start: z.string(), period_end: z.string(), orders_count: z.number().int(),
  opening_balance: Amount, closing_balance: Amount, orders_gross: Amount, commission: Amount, commission_vat: Amount, orders_net: Amount,
  refunds: Amount, adjustments: Amount, payouts: Amount, net_change: Amount, eta_invoice: z.object({ status: z.literal("not_connected"), url: z.null() }),
});
export type Statement = z.infer<typeof Statement>;

export const toMoney = (a: Amount): Money => money(BigInt(a.amount_minor), a.currency);
export const isZero = (a: Amount): boolean => BigInt(a.amount_minor) === 0n;

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Current calendar month in Africa/Cairo, `YYYY-MM` (the API's statement month is a Cairo month). */
export const cairoMonth = (now: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")?.value ?? "1970"}-${parts.find((p) => p.type === "month")?.value ?? "01"}`;
};
