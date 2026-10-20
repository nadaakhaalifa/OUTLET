import { toWireStatus, type Money } from "../domain/bridge";
import type { ShipmentView } from "../application/shipments";

const iso = (ms: number): string => new Date(ms).toISOString();

export function moneyWire(m: Money): { amount: string; currency: "EGP" } {
  return { amount: m.amount.toString(), currency: m.currency };
}

/**
 * Shipment wire shape (openapi `Shipment`). Additions over the skeleton, reported in the spec:
 * `label_status`, `delivered_at`, and the `cancelled` / `lost` statuses. Recipient data is never
 * part of this shape.
 */
export function shipmentWire(v: ShipmentView) {
  const s = v.shipment;
  return {
    id: s.id,
    seller_order_ids: [s.sellerOrderId],
    courier: s.courierCode,
    awb: s.awb,
    status: toWireStatus(s.state),
    label_status: s.labelStatus.toLowerCase() as "pending" | "ready" | "failed",
    cod_amount: s.codAmount === null ? null : moneyWire(s.codAmount),
    attempts: s.attemptsMade,
    delivered_at: s.deliveredAtMs === null ? null : iso(s.deliveredAtMs),
    events: v.events
      .filter((e) => e.outcome === "APPLIED")
      .map((e) => ({ at: iso(e.occurredAtMs), status: toWireStatus(e.toStatus) })),
  };
}
