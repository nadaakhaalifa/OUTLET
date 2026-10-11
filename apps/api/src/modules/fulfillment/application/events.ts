import type { ShipmentState } from "../domain/bridge";
import type { OutboxEvent, OutboxPayload, ShipmentRecord } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

/** Outbox event type for reaching a state, or null when no event is published for it. */
const EVENT_FOR_STATE: Readonly<Partial<Record<ShipmentState, string>>> = {
  LABEL_CREATED: "shipment.label_created",
  PICKED_UP: "shipment.picked_up",
  DELIVERED: "shipment.delivered",
  DELIVERY_ATTEMPT_FAILED: "shipment.delivery_failed",
  RTO_INITIATED: "shipment.rto_initiated",
  RETURNED_TO_SELLER: "shipment.rto_received",
  LOST: "shipment.lost",
  CANCELLED: "shipment.cancelled",
};

/**
 * Payloads carry opaque ids, statuses and timestamps only. Never recipient name, phone or address (P2).
 * `delivered_at` is the courier-confirmed time that the returns module starts its windows from.
 */
export function shipmentPayload(s: ShipmentRecord): OutboxPayload {
  return {
    shipment_id: s.id,
    seller_order_id: s.sellerOrderId,
    store_id: s.storeId,
    courier: s.courierCode,
    status: s.state,
    attempts_made: s.attemptsMade,
    cod: s.codAmount !== null,
    picked_up_at: s.pickedUpAtMs === null ? null : iso(s.pickedUpAtMs),
    delivered_at: s.deliveredAtMs === null ? null : iso(s.deliveredAtMs),
  };
}

export function eventsForTransitions(
  states: readonly ShipmentState[],
  after: ShipmentRecord,
  newId: () => string,
): OutboxEvent[] {
  const out: OutboxEvent[] = [];
  for (const state of states) {
    const type = EVENT_FOR_STATE[state];
    if (type === undefined) continue;
    out.push({ id: newId(), type, aggregateId: after.id, payload: shipmentPayload(after) });
    if (state === "DELIVERED" && after.codAmount !== null) {
      out.push({
        id: newId(),
        type: "cod.collected",
        aggregateId: after.id,
        payload: { ...shipmentPayload(after), cod_amount: after.codAmount.amount.toString() },
      });
    }
  }
  return out;
}
