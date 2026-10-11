import type { RefundLegRecord } from "../domain/ports";
import type { RefundView } from "../application/queries";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const amount = (v: bigint) => ({ amount: v.toString(), currency: "EGP" as const });

function legWire(l: RefundLegRecord) {
  return {
    id: l.id,
    method: l.method,
    channel: l.channel,
    amount: amount(l.amount),
    state: l.state,
    credit_sub: l.creditSub === null ? null : l.creditSub.kind,
    needs_payout_details: l.needsPayoutDetails,
  };
}

/** Shopper view of a refund. Ledger entries, provider references and failure internals stay server-side. */
export function refundWire(v: RefundView) {
  const r = v.refund;
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    return_id: r.returnId,
    amount: amount(r.amount),
    lines: r.lines.map((l) => ({ order_line_id: l.orderLineId, qty: l.qty, net_amount: amount(l.netAmount) })),
    legs: r.legs.map(legWire),
    requested_at: iso(r.requestedAtMs),
    initiated_at: iso(r.initiatedAtMs),
    completed_at: iso(r.completedAtMs),
    slo: v.slo,
  };
}
