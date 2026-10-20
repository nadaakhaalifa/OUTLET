import type { ReturnState } from "../domain/bridge";
import type { DisputeRecord, ReturnRecord } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * OpenAPI `Return.status`. CLOSED (rejection stands) maps to RETURN_REJECTED and APPROVED to
 * RETURN_INSPECTED. CANCELLED has no wire value and no route reaches it; reported as a gap.
 */
export function statusWire(s: ReturnState) {
  switch (s) {
    case "REQUESTED":
      return "RETURN_REQUESTED" as const;
    case "PICKUP_SCHEDULED":
      return "RETURN_PICKUP_SCHEDULED" as const;
    case "IN_TRANSIT":
      return "RETURN_IN_TRANSIT" as const;
    case "RECEIVED":
      return "RETURN_RECEIVED" as const;
    case "APPROVED":
      return "RETURN_INSPECTED" as const;
    case "REJECTED":
    case "CLOSED":
    case "CANCELLED":
      return "RETURN_REJECTED" as const;
    case "DISPUTED":
      return "DISPUTED" as const;
    case "REFUNDED":
      return "REFUNDED" as const;
    case "EXCHANGED":
      return "EXCHANGED" as const;
  }
}

export function returnWire(r: ReturnRecord) {
  return {
    id: r.id,
    order_line_id: r.orderLineId,
    seller_order_id: r.sellerOrderId,
    status: statusWire(r.state),
    reason: r.reason,
    resolution: r.resolution,
    return_shipping_payer: r.shippingPayer,
    eligibility_window_ends_at: iso(r.windowEndsAtMs),
    inspection_due_at: r.inspectionDueAtMs === null ? null : iso(r.inspectionDueAtMs),
    refund: null,
    pickup_shipment: null,
    created_at: iso(r.createdAtMs),
  };
}

export function disputeWire(d: DisputeRecord) {
  return {
    id: d.id,
    return_id: d.returnId,
    status: d.status,
    review_due_at: iso(d.reviewDueAtMs),
    created_at: iso(d.createdAtMs),
  };
}
