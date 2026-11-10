import { z } from "zod";

/** Money on the wire: bigint minor units as a decimal string (never a float) + ISO currency. */
export const MoneyWire = z.object({ amount_minor: z.string(), currency: z.string() });
const Cursor = z.string().nullable().optional();

export const REFUND_STATUSES = ["REQUESTED", "MANUAL_REVIEW", "FAILED", "PROCESSING", "COMPLETED"] as const;
export const PAYOUT_STATUSES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED"] as const;
export const RETURN_STAGES = ["requested", "in_transit", "awaiting_inspection", "inspection_overdue"] as const;
export const DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED_SHOPPER", "RESOLVED_SELLER", "WITHDRAWN"] as const;
export const HOLD_REASONS = ["risk_review", "iban_check", "dispute_pending", "kyc_review", "seller_request", "other"] as const;
export const RELEASE_REASONS = ["issue_resolved", "error_corrected", "review_cleared"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const RefundRow = z.object({
  id: z.string(), order_group_id: z.string(), seller_order_id: z.string(), store_id: z.string(), status: z.string(), reason: z.string(), route: z.string(),
  amount: MoneyWire, attempts: z.number(), overdue: z.boolean(), due_at: z.string().nullable(), created_at: z.string(), completed_at: z.string().nullable(),
});
export const RefundList = z.object({
  items: z.array(RefundRow), next_cursor: Cursor,
  summary: z.array(z.object({ status: z.string(), count: z.number(), amount: MoneyWire })), overdue_count: z.number(),
});

export const PayoutRow = z.object({
  id: z.string(), store_id: z.string(), status: z.string(), mode: z.string(), cycle_start: z.string(), cycle_end: z.string(), net: MoneyWire,
  hold_reason: z.string().nullable(), failure_code: z.string().nullable(), created_at: z.string(),
});
export const PayoutList = z.object({
  items: z.array(PayoutRow), next_cursor: Cursor,
  summary: z.array(z.object({ status: z.string(), count: z.number(), net: MoneyWire })),
});

export const ReturnRow = z.object({
  id: z.string(), order_group_id: z.string(), store_id: z.string(), status: z.string(), stage: z.string(), reason_code: z.string(), resolution: z.string(),
  created_at: z.string(), received_at: z.string().nullable(), inspection_due_at: z.string().nullable(),
});
export const ReturnList = z.object({
  items: z.array(ReturnRow), next_cursor: Cursor,
  summary: z.object({ requested: z.number(), in_transit: z.number(), awaiting_inspection: z.number(), inspection_overdue: z.number() }),
});

export const DisputeRow = z.object({
  id: z.string(), return_request_id: z.string(), store_id: z.string(), status: z.string(), reason_code: z.string(), assigned: z.boolean(),
  sla_due_at: z.string(), past_sla: z.boolean(), created_at: z.string(), resolved_at: z.string().nullable(),
});
export const DisputeList = z.object({ items: z.array(DisputeRow), next_cursor: Cursor, summary: z.object({ open: z.number(), past_sla: z.number() }) });

export type ListKind = "refunds" | "payouts" | "returns" | "disputes";
export type ChipTone = "ok" | "warn" | "bad" | "info";

/** Which query parameter filters each list, and the values it accepts (anything else is ignored: the API would answer 400). */
export const FILTERS: Readonly<Record<ListKind, { readonly param: "status" | "stage"; readonly values: readonly string[] }>> = {
  refunds: { param: "status", values: REFUND_STATUSES },
  payouts: { param: "status", values: PAYOUT_STATUSES },
  returns: { param: "stage", values: RETURN_STAGES },
  disputes: { param: "status", values: DISPUTE_STATUSES },
};

/** A value from the URL, or undefined when it is not one the list knows. */
export const parseFilter = (kind: ListKind, raw: string | undefined): string | undefined => (raw !== undefined && FILTERS[kind].values.includes(raw) ? raw : undefined);

const TONES: Readonly<Record<string, ChipTone>> = {
  FAILED: "bad", MANUAL_REVIEW: "bad", ON_HOLD: "warn", REQUESTED: "info", PROCESSING: "info", SCHEDULED: "info", APPROVED: "info", SENT: "info", COMPLETED: "ok", SETTLED: "ok",
  requested: "info", in_transit: "info", awaiting_inspection: "warn", inspection_overdue: "bad",
  OPEN: "warn", UNDER_REVIEW: "info", RESOLVED_SHOPPER: "ok", RESOLVED_SELLER: "ok", WITHDRAWN: "ok",
};
export const toneOf = (status: string): ChipTone => TONES[status] ?? "info";

/** First 8 characters of an id: enough to tell rows apart on screen; the full id is in the row's data attribute and the API. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Payout actions the row may offer (the API is the judge; this only hides buttons that could never work). */
export const canHold = (status: string): boolean => status === "SCHEDULED" || status === "APPROVED";
export const canRelease = (status: string): boolean => status === "ON_HOLD";
