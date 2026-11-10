import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { CursorQuery } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
export const PAYOUT_STATUSES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"] as const;

export const PayoutIdParams = z.strictObject({ payout_id: z.uuid() });
export type PayoutIdParams = z.infer<typeof PayoutIdParams>;

export const PayoutsQuery = CursorQuery.extend({ status: z.enum(PAYOUT_STATUSES).optional() });
export type PayoutsQuery = z.infer<typeof PayoutsQuery>;

/** Calendar month in Africa/Cairo, `YYYY-MM`. */
export const StatementQuery = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
export type StatementQuery = z.infer<typeof StatementQuery>;

/**
 * Balance (ledger projection of the store's seller_pending and seller_available, credit shown as positive) and payout totals by state.
 * `pending` = not yet payable (return window open), `available` = payable at the next cycle. `held` and `in_transit` are payouts, not extra money.
 */
export const SellerBalance = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  pending: MoneyDto,
  available: MoneyDto,
  total: MoneyDto,
  payouts: z.strictObject({ scheduled: MoneyDto, held: MoneyDto, in_transit: MoneyDto, paid_to_date: MoneyDto }),
  server_time: Iso,
});
export type SellerBalance = z.infer<typeof SellerBalance>;

const PayoutSummary = z.strictObject({
  id: z.uuid(),
  status: z.enum(PAYOUT_STATUSES),
  cycle_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cycle_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gross: MoneyDto,
  adjustments: MoneyDto,
  net: MoneyDto,
  created_at: Iso,
  sent_at: Iso.nullable(),
  settled_at: Iso.nullable(),
});
export const PayoutPage = z.strictObject({ items: z.array(PayoutSummary).max(50), next_cursor: z.string().max(512).nullable() });
export type PayoutPage = z.infer<typeof PayoutPage>;

export const MAX_PAYOUT_LINES = 500;
const PayoutLine = z.strictObject({ kind: z.enum(["order", "adjustment"]), seller_order_id: z.uuid().nullable(), amount: MoneyDto });
export const PayoutDetail = PayoutSummary.extend({ lines: z.array(PayoutLine).max(MAX_PAYOUT_LINES), lines_truncated: z.boolean() });
export type PayoutDetail = z.infer<typeof PayoutDetail>;

/** Monthly statement, a read model over ledger postings (not a stored document). Signs follow the seller's balance: credits positive. */
export const SellerStatement = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period_start: Iso,
  period_end: Iso,
  opening_balance: MoneyDto,
  closing_balance: MoneyDto,
  orders_count: z.number().int().min(0),
  /** VAT-inclusive order value credited to the seller before commission: orders_net + commission + commission_vat. */
  orders_gross: MoneyDto,
  commission: MoneyDto,
  commission_vat: MoneyDto,
  orders_net: MoneyDto,
  refunds: MoneyDto,
  adjustments: MoneyDto,
  payouts: MoneyDto,
  net_change: MoneyDto,
  eta_invoice: z.strictObject({ status: z.literal("not_connected"), url: z.null() }),
});
export type SellerStatement = z.infer<typeof SellerStatement>;
