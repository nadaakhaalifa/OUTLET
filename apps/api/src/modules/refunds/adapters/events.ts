import type { RefundEvent } from "../domain/ports";

/** Outbox payload: ids and amounts as decimal strings only (bigint safe, no contact data). */
export function eventPayload(e: RefundEvent): Record<string, string | number | null> {
  switch (e.type) {
    case "refund.requested":
    case "refund.completed":
      return { refund_id: e.refundId, user_id: e.userId, amount: e.amount.toString(), currency: "EGP", return_id: e.returnId };
    case "refund.approved":
      return { refund_id: e.refundId, user_id: e.userId };
    case "refund.failed":
      return { refund_id: e.refundId, leg_id: e.legId, code: e.code, attempts: e.attempts };
    case "refund.manual_review":
      return { refund_id: e.refundId, leg_id: e.legId, code: e.code };
    case "refund.intent_rejected":
      return { return_id: e.returnId, reason: e.reason };
  }
}

export function aggregateOf(e: RefundEvent): string {
  return e.type === "refund.intent_rejected" ? e.returnId : e.refundId;
}
