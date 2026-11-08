import { GENERIC_STATUS_MAP } from "./domain/tracking-map.js";
import type { CourierEvent, CourierPort, CreateShipmentRequest, CreatedShipment, NormalisedEvent, ShipmentLabelPort } from "./domain/ports.js";

/** TEST ONLY. In-memory courier: idempotent by shipmentId, no network. */
export class FakeCourier implements CourierPort, ShipmentLabelPort {
  readonly created = new Map<string, CreatedShipment>();
  readonly cancelled = new Set<string>();
  failNext = false;
  private seq = 0;

  createShipment(req: CreateShipmentRequest): Promise<CreatedShipment> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("courier unavailable"));
    }
    const existing = this.created.get(req.shipmentId);
    if (existing !== undefined) return Promise.resolve(existing);
    const made = { awb: `FAKE${String(++this.seq).padStart(8, "0")}`, courier: req.courier };
    this.created.set(req.shipmentId, made);
    return Promise.resolve(made);
  }
  cancelShipment(awb: string): Promise<void> {
    this.cancelled.add(awb);
    return Promise.resolve();
  }
  normalise(event: CourierEvent): NormalisedEvent | undefined {
    const status = GENERIC_STATUS_MAP[event.rawStatus];
    return status === undefined ? undefined : { eventId: event.eventId, awb: event.awb, status, occurredAt: event.occurredAt };
  }
  getLabel(awb: string): Promise<{ readonly contentType: "application/pdf"; readonly bytes: Uint8Array }> {
    return Promise.resolve({ contentType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-fake ${awb}`) });
  }
}

/** Production default until a courier contract exists (V33/V43): every call fails closed. */
export class UnconfiguredCourier implements CourierPort {
  createShipment(): Promise<CreatedShipment> { return Promise.reject(new Error("courier adapter unconfigured")); }
  cancelShipment(): Promise<void> { return Promise.reject(new Error("courier adapter unconfigured")); }
  normalise(): undefined { return undefined; }
}
