import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime({ offset: true });

// ---- refunds (admin read list; ids and amounts only: no shopper identity, no free text, no provider message)
export const REFUND_STATUSES = ["REQUESTED", "MANUAL_REVIEW", "FAILED", "PROCESSING", "COMPLETED"] as const;
export const RefundsQuery = CursorQuery.extend({ status: z.enum(REFUND_STATUSES).optional() });
export type RefundsQuery = z.infer<typeof RefundsQuery>;
export const RefundDto = z.strictObject({
  id: z.uuid(),
  order_group_id: z.uuid(),
  seller_order_id: z.uuid(),
  return_request_id: z.uuid().nullable(),
  store_id: z.uuid(),
  status: z.enum(REFUND_STATUSES),
  reason: z.enum(["return", "seller_rejected", "goodwill", "cancellation"]),
  route: z.enum(["psp_original", "bnpl_provider", "store_credit", "bank_transfer", "fawry_voucher", "mixed"]),
  amount: MoneyDto,
  attempts: z.number().int().min(0),
  /** Past `due_at` and not completed (computed at read time). */
  overdue: z.boolean(),
  due_at: Iso.nullable(),
  created_at: Iso,
  completed_at: Iso.nullable(),
});
export type RefundDto = z.infer<typeof RefundDto>;
/** Not-completed refunds of the market (whatever the filter and the page), per status and currency. COMPLETED is not summarised: that scan is unbounded and the list already pages it. */
export const RefundSummaryRow = z.strictObject({ status: z.enum(["REQUESTED", "MANUAL_REVIEW", "FAILED", "PROCESSING"]), count: z.number().int().min(0), amount: MoneyDto });
export const RefundPage = pageOf(RefundDto).extend({ summary: z.array(RefundSummaryRow).max(40), overdue_count: z.number().int().min(0) });
export type RefundPage = z.infer<typeof RefundPage>;

// ---- payouts
export const PAYOUT_STATUSES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED"] as const;
export const PayoutsQuery = CursorQuery.extend({ status: z.enum(PAYOUT_STATUSES).optional() });
export type PayoutsQuery = z.infer<typeof PayoutsQuery>;
export const PayoutIdParams = z.strictObject({ payout_id: z.uuid() });
export type PayoutIdParams = z.infer<typeof PayoutIdParams>;
export const PayoutDto = z.strictObject({
  id: z.uuid(),
  store_id: z.uuid(),
  /** CANCELLED payouts exist in the table but are never listed. */
  status: z.enum(PAYOUT_STATUSES),
  mode: z.enum(["transfer", "statement"]),
  cycle_start: z.iso.date(),
  cycle_end: z.iso.date(),
  gross: MoneyDto,
  adjustments: MoneyDto,
  net: MoneyDto,
  /** System or staff reason code (`iban_name_mismatch`, `rail_failed:...`, `ops:risk_review`); never free text. */
  hold_reason: z.string().max(100).nullable(),
  failure_code: z.string().max(100).nullable(),
  approval_request_id: z.uuid().nullable(),
  sent_at: Iso.nullable(),
  settled_at: Iso.nullable(),
  created_at: Iso,
});
export type PayoutDto = z.infer<typeof PayoutDto>;
/** Same fields, unknown keys stripped (turns a PayoutDetailDto into the plain PayoutDto). */
export const PayoutDtoStrip = z.object(PayoutDto.shape);
export const PayoutPage = pageOf(PayoutDto).extend({ summary: z.array(z.strictObject({ status: z.enum(["SCHEDULED", "ON_HOLD", "APPROVED", "FAILED"]), count: z.number().int().min(0), net: MoneyDto })).max(40) });
export type PayoutPage = z.infer<typeof PayoutPage>;
export const PayoutHoldDto = z.strictObject({
  id: z.uuid(),
  reason: z.enum(["risk", "enforcement", "kyc", "dispute"]),
  seller_order_id: z.uuid().nullable(),
  starts_at: Iso,
  released_at: Iso.nullable(),
});
export const PayoutDetailDto = PayoutDto.extend({
  /** Payout lines (accrual rows) behind this payout. */
  line_count: z.number().int().min(0),
  /** Holds of the store that block payouts (released ones are not listed). */
  open_holds: z.array(PayoutHoldDto).max(50),
});
export type PayoutDetailDto = z.infer<typeof PayoutDetailDto>;

export const PAYOUT_HOLD_REASONS = ["risk_review", "iban_check", "dispute_pending", "kyc_review", "seller_request", "other"] as const;
export const PAYOUT_RELEASE_REASONS = ["issue_resolved", "error_corrected", "review_cleared"] as const;
export const PayoutHoldInput = z.strictObject({ reason_code: z.enum(PAYOUT_HOLD_REASONS) });
export type PayoutHoldInput = z.infer<typeof PayoutHoldInput>;
export const PayoutReleaseInput = z.strictObject({ reason_code: z.enum(PAYOUT_RELEASE_REASONS) });
export type PayoutReleaseInput = z.infer<typeof PayoutReleaseInput>;

// ---- returns
export const RETURN_STAGES = ["requested", "in_transit", "awaiting_inspection", "inspection_overdue"] as const;
export const ReturnsQuery = CursorQuery.extend({ stage: z.enum(RETURN_STAGES).optional() });
export type ReturnsQuery = z.infer<typeof ReturnsQuery>;
export const ReturnDto = z.strictObject({
  id: z.uuid(),
  order_group_id: z.uuid(),
  seller_order_id: z.uuid(),
  store_id: z.uuid(),
  status: z.enum(["REQUESTED", "IN_TRANSIT", "RECEIVED"]),
  stage: z.enum(RETURN_STAGES),
  reason_code: z.string().max(60),
  resolution: z.enum(["refund", "exchange", "store_credit"]),
  created_at: Iso,
  received_at: Iso.nullable(),
  inspection_due_at: Iso.nullable(),
});
export type ReturnDto = z.infer<typeof ReturnDto>;
export const ReturnPage = pageOf(ReturnDto).extend({
  summary: z.strictObject({ requested: z.number().int().min(0), in_transit: z.number().int().min(0), awaiting_inspection: z.number().int().min(0), inspection_overdue: z.number().int().min(0) }),
});
export type ReturnPage = z.infer<typeof ReturnPage>;

// ---- disputes (the shopper's note is free text and is never returned)
export const DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED_SHOPPER", "RESOLVED_SELLER", "WITHDRAWN"] as const;
export const DisputesQuery = CursorQuery.extend({ status: z.enum(DISPUTE_STATUSES).optional() });
export type DisputesQuery = z.infer<typeof DisputesQuery>;
export const DisputeDto = z.strictObject({
  id: z.uuid(),
  return_request_id: z.uuid(),
  store_id: z.uuid(),
  status: z.enum(DISPUTE_STATUSES),
  reason_code: z.string().max(60),
  assigned: z.boolean(),
  sla_due_at: Iso,
  past_sla: z.boolean(),
  created_at: Iso,
  resolved_at: Iso.nullable(),
});
export type DisputeDto = z.infer<typeof DisputeDto>;
export const DisputePage = pageOf(DisputeDto).extend({ summary: z.strictObject({ open: z.number().int().min(0), past_sla: z.number().int().min(0) }) });
export type DisputePage = z.infer<typeof DisputePage>;

