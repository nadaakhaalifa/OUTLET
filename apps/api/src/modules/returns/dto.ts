import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();

/** Contract `ReturnRequestInput.reason_code` plus the two precise defect codes of the package; `defective` is the undisclosed-defect claim. */
export const RETURN_REASON_INPUT = ["too_small", "too_large", "not_as_described", "defective", "undisclosed_defect", "defect_undisclosed", "defect_worse_than_shown", "changed_mind", "late", "wrong_item"] as const;
export const REASON_TO_PACKAGE = {
  too_small: "too_small", too_large: "too_large", not_as_described: "not_as_described", defective: "defect_undisclosed", undisclosed_defect: "defect_undisclosed",
  defect_undisclosed: "defect_undisclosed", defect_worse_than_shown: "defect_worse_than_shown", changed_mind: "changed_mind", late: "late", wrong_item: "wrong_item",
} as const;

export const SellerOrderIdParams = z.strictObject({ seller_order_id: z.uuid() });
export type SellerOrderIdParams = z.infer<typeof SellerOrderIdParams>;
export const ReturnIdParams = z.strictObject({ return_id: z.uuid() });
export type ReturnIdParams = z.infer<typeof ReturnIdParams>;
export const OrderGroupIdParams = z.strictObject({ order_group_id: z.uuid() });
export type OrderGroupIdParams = z.infer<typeof OrderGroupIdParams>;

export const ReturnRequestInput = z.strictObject({
  lines: z.array(z.strictObject({ order_line_id: z.uuid(), qty: z.number().int().min(1).max(10) })).min(1).max(50),
  reason_code: z.enum(RETURN_REASON_INPUT),
  method: z.enum(["pickup", "dropoff"]),
  /** `refund` insists on money back; `exchange` is honoured for size reasons when the swap is in stock (exchange first, section 22). */
  resolution: z.enum(["refund", "exchange"]),
  refund_preference: z.enum(["original", "store_credit"]).optional(),
  evidence_media_ids: z.array(z.uuid()).max(10).optional(),
});
export type ReturnRequestInput = z.infer<typeof ReturnRequestInput>;

export const ReturnsQuery = CursorQuery.extend({ status: z.string().regex(/^[A-Z_]{3,30}$/).optional() });
export type ReturnsQuery = z.infer<typeof ReturnsQuery>;

const ReturnLine = z.strictObject({
  id: z.uuid(),
  order_line_id: z.uuid(),
  qty: z.number().int(),
  item_unit_id: z.uuid().nullable(),
  condition_received: z.string().max(100).nullable(),
  restock_decision: z.string().max(100).nullable(),
});

export const ReturnRequest = z.strictObject({
  id: z.uuid(),
  seller_order_id: z.uuid(),
  status: z.enum(["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "INSPECTED", "ACCEPTED", "REJECTED", "DISPUTED", "CLOSED", "CANCELLED"]),
  reason_code: z.string().max(100),
  fault: z.enum(["shopper", "seller", "courier", "none"]),
  window_basis: z.enum(["no_reason", "defect"]),
  delivered_at_snapshot: Iso,
  window_ends_at: Iso,
  method: z.enum(["pickup", "dropoff"]),
  resolution: z.enum(["refund", "exchange"]),
  lines: z.array(ReturnLine).max(50),
  /** Seller's reason code, present only once the return is rejected. */
  rejection_reason: z.string().max(100).nullable(),
  received_at: Iso.nullable(),
  inspection_due_at: Iso.nullable(),
  refund_due_at: Iso.nullable(),
  created_at: Iso,
});
export type ReturnRequest = z.infer<typeof ReturnRequest>;
export const ReturnRequestPage = pageOf(ReturnRequest);
export type ReturnRequestPage = z.infer<typeof ReturnRequestPage>;

export const DISPUTE_REASONS = ["item_was_defective", "item_not_as_described", "rejection_unjustified", "item_not_received_by_seller", "other"] as const;
export const DisputeInput = z.strictObject({
  statement: z.string().trim().min(1).max(2000),
  /** Package reason code; a rejected return defaults to `rejection_unjustified`, anything else to `other`. */
  reason_code: z.enum(DISPUTE_REASONS).optional(),
  /** Dispute evidence has no storage yet: a non-empty list is refused (422), never silently dropped. */
  media_ids: z.array(z.uuid()).max(50).optional(),
});
export type DisputeInput = z.infer<typeof DisputeInput>;
export const Dispute = z.strictObject({
  id: z.uuid(),
  return_request_id: z.uuid(),
  status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED_SHOPPER", "RESOLVED_SELLER", "WITHDRAWN"]),
  sla_due_at: Iso,
  created_at: Iso,
  resolved_at: Iso.nullable(),
});
export type Dispute = z.infer<typeof Dispute>;

export const InspectionInput = z.strictObject({
  result: z.enum(["accepted", "rejected"]),
  /** A rejection needs a reason code (package rule); defaults to `inspection_rejected`. */
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
  notes: z.string().trim().max(500).optional(),
  media_ids: z.array(z.uuid()).max(50).optional(),
  lines: z.array(z.strictObject({ return_line_id: z.uuid(), condition_received: z.enum(["as_new", "used", "damaged", "defective", "missing"]), restock_decision: z.enum(["restock", "write_off", "relist_open_box", "donate"]) })).max(50),
});
export type InspectionInput = z.infer<typeof InspectionInput>;

export const EmptyBody = z.strictObject({});
export type EmptyBody = z.infer<typeof EmptyBody>;

export const CancelInput = z.strictObject({ reason_code: z.enum(["changed_mind", "ordered_by_mistake", "delivery_too_slow", "other"]), refund_preference: z.enum(["original", "store_credit"]).optional() });
export type CancelInput = z.infer<typeof CancelInput>;
