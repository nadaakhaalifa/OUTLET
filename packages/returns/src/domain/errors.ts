export type ReturnsErrorCode =
  | "not_found"
  | "forbidden"
  | "not_delivered"
  | "window_closed"
  | "disclosed_defect"
  | "non_returnable"
  | "photos_required"
  | "evidence_invalid"
  | "nothing_to_return"
  | "qty_exceeds_purchased"
  | "bnpl_provider_only"
  | "request_bnpl_provider_only"
  | "refunds_disabled"
  | "refund_exceeds_paid"
  | "commission_base_mismatch"
  | "seller_net_negative"
  | "invalid_state"
  | "inspection_not_due"
  | "approval_required";

/** Typed, user-safe error. `not_found` is also used for foreign objects so existence never leaks (404, never 403). */
export class ReturnsError extends Error {
  constructor(readonly code: ReturnsErrorCode, message: string = code) {
    super(message);
    this.name = "ReturnsError";
  }
}
