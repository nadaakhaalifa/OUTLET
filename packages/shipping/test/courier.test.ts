import { describe, expect, it } from "vitest";
import { GENERIC_STATUS_MAP, SHIPMENT_STATUSES, applyTracking } from "../src/index.js";
import type { CourierEvent, ShipmentState } from "../src/index.js";
import { FakeCourier, UnconfiguredCourier } from "../src/testing.js";

const req = { shipmentId: "ship-1", courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 500 }], destination: { governorateCode: "CAI", street: "s", building: "1" }, recipient: { name: "N", phone: "+201001234567" }, codMinor: 0n };

describe("fake courier", () => {
  it("createShipment is idempotent by shipment id and can fail", async () => {
    const c = new FakeCourier();
    const a = await c.createShipment(req);
    expect(await c.createShipment(req)).toEqual(a);
    expect(c.created.size).toBe(1);
    c.failNext = true;
    await expect(c.createShipment({ ...req, shipmentId: "ship-2" })).rejects.toThrow();
    expect((await c.getLabel(a.awb)).contentType).toBe("application/pdf");
  });
  it("normalises known raw statuses and never guesses unknown ones", () => {
    const c = new FakeCourier();
    const ev = (rawStatus: string): CourierEvent => ({ eventId: "e", awb: "A", rawStatus, occurredAt: "2030-01-01T00:00:00Z" });
    expect(c.normalise(ev("out_for_delivery"))?.status).toBe("OUT_FOR_DELIVERY");
    expect(c.normalise(ev("weird"))).toBeUndefined();
    expect(Object.values(GENERIC_STATUS_MAP).every((s) => SHIPMENT_STATUSES.includes(s))).toBe(true);
  });
  it("replaying a tracking feed twice yields the same shipment state", () => {
    const c = new FakeCourier();
    const feed = ["created", "picked_up", "in_transit", "out_for_delivery", "delivery_failed", "out_for_delivery", "delivered"];
    const run = (): ShipmentState => {
      let s: ShipmentState = { status: "LABEL_PENDING", attempts: 0 };
      for (const raw of feed) {
        const n = c.normalise({ eventId: raw, awb: "A", rawStatus: raw, occurredAt: "t" });
        if (n) s = applyTracking(s, n.status).state;
      }
      return s;
    };
    const once = run();
    expect(once).toEqual({ status: "DELIVERED", attempts: 1 });
    expect(run()).toEqual(once);
  });
  it("the production default fails closed", async () => {
    await expect(new UnconfiguredCourier().createShipment()).rejects.toThrow("unconfigured");
  });
});
