import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shipmentMachine, MAX_SHIPMENT_ATTEMPTS } from "../state-machine";
import { applyAwbCreated, applyTracking, newShipmentSnapshot } from "./tracking";
import { FULFILLMENT_TRACKING_KINDS, type FulfillmentTrackingEvent, type ShipmentSnapshot } from "./types";

const eventsArb = fc
  .array(
    fc.record({
      kind: fc.constantFrom(...FULFILLMENT_TRACKING_KINDS),
      at: fc.integer({ min: 1, max: 1_000_000 }),
    }),
    { maxLength: 40 },
  )
  .map((xs): FulfillmentTrackingEvent[] =>
    xs.map((x, i) => ({ courierEventId: `evt-${i}`, kind: x.kind, occurredAtMs: x.at, reasonCode: null })),
  );

/** What the repository does: dedup by courier event id, then reduce. */
function ingest(start: ShipmentSnapshot, events: readonly FulfillmentTrackingEvent[], seen: Set<string>): ShipmentSnapshot {
  let s = start;
  for (const e of events) {
    if (seen.has(e.courierEventId)) continue;
    seen.add(e.courierEventId);
    s = applyTracking(s, e).next;
  }
  return s;
}

describe("tracking reducer properties", () => {
  it("replaying every webhook twice yields identical shipment state", () => {
    fc.assert(
      fc.property(eventsArb, fc.boolean(), (events, cod) => {
        const start = applyAwbCreated(newShipmentSnapshot(cod));
        const once = ingest(start, events, new Set());
        const seen = new Set<string>();
        const twice = ingest(ingest(start, events, seen), events, seen);
        expect(twice).toEqual(once);
      }),
      { numRuns: 400 },
    );
  });

  it("interleaved duplicates change nothing either", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const start = applyAwbCreated(newShipmentSnapshot(false));
        const doubled = events.flatMap((e) => [e, e]);
        expect(ingest(start, doubled, new Set())).toEqual(ingest(start, events, new Set()));
      }),
      { numRuns: 200 },
    );
  });

  it("always lands on a valid state, never exceeds 3 attempts and never rewrites delivered_at", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        let s = applyAwbCreated(newShipmentSnapshot(true));
        let deliveredAt: number | null = null;
        for (const e of events) {
          s = applyTracking(s, e).next;
          expect(shipmentMachine.isState(s.state)).toBe(true);
          expect(s.attemptsMade).toBeLessThanOrEqual(MAX_SHIPMENT_ATTEMPTS);
          if (deliveredAt !== null) expect(s.deliveredAtMs).toBe(deliveredAt);
          deliveredAt = s.deliveredAtMs;
          if (s.state === "DELIVERED") expect(s.deliveredAtMs).not.toBeNull();
        }
      }),
      { numRuns: 400 },
    );
  });

  it("never leaves a terminal state", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        let s = applyAwbCreated(newShipmentSnapshot(false));
        let terminal: string | null = null;
        for (const e of events) {
          s = applyTracking(s, e).next;
          if (terminal !== null) expect(s.state).toBe(terminal);
          if (shipmentMachine.isTerminal(s.state)) terminal = s.state;
        }
      }),
      { numRuns: 300 },
    );
  });
});
