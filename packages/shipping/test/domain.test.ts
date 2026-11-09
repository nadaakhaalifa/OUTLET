import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_SHIPMENT_STATUSES, MAX_DELIVERY_ATTEMPTS, SHIPMENT_STATUSES, ShippingError, TRANSITIONS, addressSchema, applyTracking, chargeableWeight, codEligible, quoteShipment, transition, volumetricGrams,
} from "../src/index.js";
import type { CourierOffer, ShipmentState, ShipmentStatus } from "../src/index.js";

const RUNS = { numRuns: 1000 };
const dims = fc.record({ lengthMm: fc.integer({ min: 1, max: 1500 }), widthMm: fc.integer({ min: 1, max: 1500 }), heightMm: fc.integer({ min: 1, max: 1500 }) });
const step = fc.constantFrom(100, 250, 500, 1000);
const divisor = fc.constantFrom(4000, 5000, 6000);

describe("chargeableWeight properties", () => {
  it("never below actual, a multiple of the break, and at least the volumetric weight", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 30_000 }), fc.option(dims, { nil: undefined }), divisor, step, (g, d, dv, st) => {
      const c = chargeableWeight(g, d, dv, st);
      expect(c).toBeGreaterThanOrEqual(g);
      expect(c % st).toBe(0);
      if (d !== undefined) expect(c).toBeGreaterThanOrEqual(volumetricGrams(d, dv));
      expect(c - Math.max(g, d === undefined ? 0 : volumetricGrams(d, dv))).toBeLessThan(st);
    }), RUNS);
  });
  it("is idempotent on breaks", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 30_000 }), dims, divisor, step, (g, d, dv, st) => {
      const c = chargeableWeight(g, d, dv, st);
      expect(chargeableWeight(c, undefined, dv, st)).toBe(c);
    }), RUNS);
  });
  it("is monotonic in actual weight and in each dimension", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 0, max: 5_000 }), dims, fc.integer({ min: 0, max: 500 }), divisor, step, (g, extra, d, dExtra, dv, st) => {
      expect(chargeableWeight(g + extra, d, dv, st)).toBeGreaterThanOrEqual(chargeableWeight(g, d, dv, st));
      const bigger = { ...d, heightMm: d.heightMm + dExtra };
      expect(chargeableWeight(g, bigger, dv, st)).toBeGreaterThanOrEqual(chargeableWeight(g, d, dv, st));
    }), RUNS);
  });
  it("matches the spec formula: 400x300x200 mm at 5000 is 4.8 kg", () => {
    expect(volumetricGrams({ lengthMm: 400, widthMm: 300, heightMm: 200 }, 5000)).toBe(4800);
    expect(chargeableWeight(1000, { lengthMm: 400, widthMm: 300, heightMm: 200 }, 5000, 500)).toBe(5000);
  });
  it("rejects bad input with a typed error", () => {
    expect(() => chargeableWeight(0, undefined, 5000, 500)).toThrow(ShippingError);
    expect(() => chargeableWeight(100, { lengthMm: 0, widthMm: 1, heightMm: 1 }, 5000, 500)).toThrow(ShippingError);
  });
});

const offer = (o: Partial<CourierOffer> & { courier: string; price: bigint }): CourierOffer => ({
  serviceLevel: "standard", geoAreaId: "gov", slaDaysP80: 3, codSupported: true, stepG: 500, volumetricDivisor: 5000, currency: "EGP",
  bands: [{ weightFromG: 0, weightToG: 2000, priceMinor: o.price }, { weightFromG: 2000, weightToG: 10_000, priceMinor: o.price + o.price }], ...o,
});
const base = { storeId: "s", destination: { areaIds: ["gov"] }, lines: [{ weightG: 400, codAllowed: true }], subtotalMinor: 50_000n, currency: "EGP", plus: false, thresholdMinor: 200_000n } as const;

describe("quoteShipment", () => {
  it("picks the cheapest eligible courier, ties broken by sla then name", () => {
    const q = quoteShipment({ ...base, offers: [offer({ courier: "b", price: 6000n }), offer({ courier: "a", price: 5000n, slaDaysP80: 4 }), offer({ courier: "c", price: 5000n, slaDaysP80: 2 })] });
    expect(q).toMatchObject({ courier: "c", etaDays: 2, freeDelivery: false });
    expect(q.fee.amountMinor).toBe(5000n);
  });
  it("NO_COVERAGE without a covering offer, never a guessed fee", () => {
    expect(() => quoteShipment({ ...base, offers: [] })).toThrow(expect.objectContaining({ code: "NO_COVERAGE" }));
    expect(() => quoteShipment({ ...base, offers: [offer({ courier: "a", price: 1n, geoAreaId: "elsewhere" })] })).toThrow(expect.objectContaining({ code: "NO_COVERAGE" }));
    expect(() => quoteShipment({ ...base, offers: [offer({ courier: "a", price: 1n })], allowedCouriers: ["zzz"] })).toThrow(expect.objectContaining({ code: "NO_COVERAGE" }));
  });
  it("OVERWEIGHT when no band fits", () => {
    expect(() => quoteShipment({ ...base, lines: [{ weightG: 20_000, codAllowed: true }], offers: [offer({ courier: "a", price: 1n })] })).toThrow(expect.objectContaining({ code: "OVERWEIGHT" }));
  });
  it("free delivery at or above the threshold, or for Plus; the courier cost is still recorded", () => {
    const offers = [offer({ courier: "a", price: 5000n })];
    expect(quoteShipment({ ...base, offers, subtotalMinor: 199_999n }).freeDelivery).toBe(false);
    const atThreshold = quoteShipment({ ...base, offers, subtotalMinor: 200_000n });
    expect(atThreshold).toMatchObject({ freeDelivery: true });
    expect(atThreshold.fee.amountMinor).toBe(0n);
    expect(atThreshold.courierCost.amountMinor).toBe(5000n);
    expect(quoteShipment({ ...base, offers, plus: true }).fee.amountMinor).toBe(0n);
  });
  it("prefers the most specific destination area per courier", () => {
    const q = quoteShipment({ ...base, destination: { areaIds: ["city", "gov"] }, offers: [offer({ courier: "a", price: 9000n, geoAreaId: "gov" }), offer({ courier: "a", price: 4000n, geoAreaId: "city" })] });
    expect(q.fee.amountMinor).toBe(4000n);
  });
  it("COD only when the courier supports it and every line allows it", () => {
    const offers = [offer({ courier: "a", price: 5000n })];
    expect(quoteShipment({ ...base, offers }).codAvailable).toBe(true);
    expect(quoteShipment({ ...base, offers, lines: [{ weightG: 400, codAllowed: false }] }).codAvailable).toBe(false);
    expect(quoteShipment({ ...base, offers: [offer({ courier: "a", price: 5000n, codSupported: false })] }).codAvailable).toBe(false);
  });
  it("volumetric weight moves the band; the fee is always a non-negative bigint from a band price (property)", () => {
    const offers = [offer({ courier: "a", price: 5000n })];
    fc.assert(fc.property(fc.array(fc.record({ weightG: fc.integer({ min: 1, max: 400 }), qty: fc.integer({ min: 1, max: 5 }), codAllowed: fc.boolean() }), { minLength: 1, maxLength: 3 }), fc.bigInt({ min: 0n, max: 500_000n }), fc.boolean(), (lines, sub, plus) => {
      const q = quoteShipment({ ...base, lines, subtotalMinor: sub, plus, offers });
      expect([0n, 5000n, 10_000n]).toContain(q.fee.amountMinor);
      expect(q.freeDelivery).toBe(plus || sub >= 200_000n);
      expect(q.fee.amountMinor).toBe(q.freeDelivery ? 0n : q.courierCost.amountMinor);
    }), RUNS);
  });
});

describe("address", () => {
  const ok = { governorateCode: "CAI", street: "s", building: "1" };
  it("requires the structured fields", () => {
    expect(addressSchema.safeParse(ok).success).toBe(true);
    expect(addressSchema.safeParse({ governorateCode: "CAI" }).success).toBe(false);
  });
  it("COD needs a landmark and a pin", () => {
    expect(codEligible(addressSchema.parse(ok))).toBe(false);
    expect(codEligible(addressSchema.parse({ ...ok, landmark: "near mosque" }))).toBe(false);
    expect(codEligible(addressSchema.parse({ ...ok, pin: { lat: 30, lng: 31 } }))).toBe(false);
    expect(codEligible(addressSchema.parse({ ...ok, landmark: "near mosque", pin: { lat: 30, lng: 31 } }))).toBe(true);
  });
});

describe("shipment state machine", () => {
  const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof ShippingError ? e.code : "other"; } return undefined; };
  it("every table transition works and every other pair throws INVALID_TRANSITION", () => {
    for (const from of SHIPMENT_STATUSES) for (const to of SHIPMENT_STATUSES) {
      const allowed = TRANSITIONS[from].includes(to);
      expect(code(() => transition({ status: from, attempts: 0 }, to))).toBe(allowed ? undefined : "INVALID_TRANSITION");
    }
  });
  it("terminal states have no exits and every state is reachable from LABEL_PENDING", () => {
    const seen = new Set<ShipmentStatus>(["LABEL_PENDING"]);
    for (const queue: ShipmentStatus[] = ["LABEL_PENDING"]; queue.length > 0;) {
      for (const n of TRANSITIONS[queue.shift()!]) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect([...seen].sort()).toEqual([...SHIPMENT_STATUSES].sort());
    for (const t of ["DELIVERED", "RETURNED_TO_SELLER", "CANCELLED"] as const) expect(TRANSITIONS[t]).toEqual([]);
  });
  it("three failed attempts go to RTO", () => {
    let s: ShipmentState = { status: "OUT_FOR_DELIVERY", attempts: 0 };
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      s = applyTracking(s, "DELIVERY_FAILED").state;
      expect(s).toEqual({ status: "DELIVERY_FAILED", attempts: i });
      s = applyTracking(s, "OUT_FOR_DELIVERY").state;
    }
    expect(applyTracking(s, "DELIVERY_FAILED").state).toEqual({ status: "RTO", attempts: 3 });
  });
  it("replaying any event twice leaves the state identical (idempotent)", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...SHIPMENT_STATUSES), { maxLength: 12 }), (events) => {
      let a: ShipmentState = { status: "LABEL_PENDING", attempts: 0 };
      let b = a;
      for (const e of events) {
        try { a = applyTracking(a, e).state; } catch { /* invalid transitions are rejected, state unchanged */ }
        try { b = applyTracking(applyTracking(b, e).state, e).state; } catch { /* same */ }
        expect(b).toEqual(a);
      }
    }), RUNS);
  });
});

describe("cancellation edges (M4)", () => {
  it("only LABEL_PENDING and LABEL_READY may be cancelled; picked-up and later is a return, never a cancel", () => {
    expect([...CANCELLABLE_SHIPMENT_STATUSES].sort()).toEqual(["LABEL_PENDING", "LABEL_READY"]);
    for (const from of SHIPMENT_STATUSES) {
      const ok = CANCELLABLE_SHIPMENT_STATUSES.includes(from);
      let got: string | undefined;
      try { transition({ status: from, attempts: 0 }, "CANCELLED"); } catch (e) { got = e instanceof ShippingError ? e.code : "other"; }
      expect(got).toBe(ok ? undefined : "INVALID_TRANSITION");
    }
  });
});

