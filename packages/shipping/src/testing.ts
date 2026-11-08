import { GENERIC_STATUS_MAP } from "./domain/tracking-map.js";
import type { CourierEvent, CourierPort, CourierWebhookPort, CreateShipmentRequest, CreatedShipment, LabelStorePort, NormalisedEvent, PiiCipher, ShipmentLabelPort } from "./domain/ports.js";

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

/** TEST ONLY. Webhook port: signature header must equal "valid"; body is JSON `{ "events": [CourierEvent] }`. */
export class FakeWebhook implements CourierWebhookPort {
  verify(_raw: string, headers: Readonly<Record<string, string>>): boolean { return headers["x-signature"] === "valid"; }
  parse(raw: string): readonly CourierEvent[] { return (JSON.parse(raw) as { events: CourierEvent[] }).events; }
}
/** TEST ONLY. Reversible fake cipher. */
export class FakeCipher implements PiiCipher {
  encrypt(p: string, aad: string): Promise<Uint8Array> { return Promise.resolve(new TextEncoder().encode(`${aad}|${p}`)); }
  decrypt(c: Uint8Array, aad: string): Promise<string> {
    const s = new TextDecoder().decode(c);
    if (!s.startsWith(`${aad}|`)) return Promise.reject(new Error("aad mismatch"));
    return Promise.resolve(s.slice(aad.length + 1));
  }
}
/** TEST ONLY. In-memory label store. */
export class FakeLabelStore implements LabelStorePort {
  readonly objects = new Map<string, Uint8Array>();
  put(key: string, bytes: Uint8Array): Promise<void> { this.objects.set(key, bytes); return Promise.resolve(); }
}
