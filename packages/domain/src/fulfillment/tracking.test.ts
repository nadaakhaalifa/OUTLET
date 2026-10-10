import { describe, expect, it } from "vitest";
import { applyAwbCreated, applyTracking, newShipmentSnapshot, toWireStatus } from "./tracking";
import type { FulfillmentTrackingEvent, FulfillmentTrackingKind, ShipmentSnapshot } from "./types";

const ev = (kind: FulfillmentTrackingKind, at = 1_000, id = `e-${kind}-${at}`): FulfillmentTrackingEvent => ({
  courierEventId: id,
  kind,
  occurredAtMs: at,
  reasonCode: null,
});

const run = (start: ShipmentSnapshot, ...events: FulfillmentTrackingEvent[]): ShipmentSnapshot =>
  events.reduce((s, e) => applyTracking(s, e).next, start);

const created = (cod = false) => applyAwbCreated(newShipmentSnapshot(cod));

describe("applyTracking forward path", () => {
  it("walks one rung at a time and stamps picked_up and delivered times", () => {
    const s = run(
      created(),
      ev("picked_up", 10),
      ev("in_transit", 20),
      ev("out_for_delivery", 30),
      ev("delivered", 40),
    );
    expect(s.state).toBe("DELIVERED");
    expect(s.pickedUpAtMs).toBe(10);
    expect(s.deliveredAtMs).toBe(40);
  });

  it("walks through skipped rungs when the courier jumps ahead", () => {
    const out = applyTracking(created(), ev("delivered", 99));
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.steps.map((x) => x.event)).toEqual(["PICK_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVER"]);
    expect(out.next.deliveredAtMs).toBe(99);
  });

  it("creates the label itself when the webhook beats the AWB write", () => {
    const out = applyTracking(newShipmentSnapshot(false), ev("picked_up", 5));
    expect(out.kind === "applied" && out.steps[0]?.event).toBe("CREATE_LABEL");
  });

  it("ignores a stale kind and keeps state", () => {
    const s = run(created(), ev("out_for_delivery", 30));
    const out = applyTracking(s, ev("in_transit", 40));
    expect(out).toMatchObject({ kind: "ignored", reason: "stale" });
    expect(out.next).toEqual(s);
  });

  it("never overwrites delivered_at", () => {
    const s = run(created(), ev("delivered", 100));
    const again = applyTracking(s, ev("delivered", 500, "other-id"));
    expect(again.kind).toBe("ignored");
    expect(again.next.deliveredAtMs).toBe(100);
  });
});

describe("delivery attempts and RTO", () => {
  const attempt = (n: number) => [ev("out_for_delivery", n * 100, `ofd${n}`), ev("delivery_failed", n * 100 + 1, `fail${n}`)];

  it("counts attempts and retries after a failure", () => {
    const s = run(created(), ...attempt(1), ev("out_for_delivery", 300, "ofd-again"));
    expect(s.state).toBe("OUT_FOR_DELIVERY");
    expect(s.attemptsMade).toBe(1);
  });

  it("initiates RTO immediately on the third failed attempt", () => {
    const s = run(created(), ...attempt(1), ...attempt(2), ...attempt(3));
    expect(s.state).toBe("RTO_INITIATED");
    expect(s.attemptsMade).toBe(3);
  });

  it("does not count a second failure without a new out_for_delivery", () => {
    const s = run(created(), ...attempt(1));
    const out = applyTracking(s, ev("delivery_failed", 900, "dup-fail"));
    expect(out).toMatchObject({ kind: "ignored", reason: "stale" });
    expect(out.next.attemptsMade).toBe(1);
  });

  it("delivers after a failed attempt", () => {
    const s = run(created(), ...attempt(1), ev("delivered", 700));
    expect(s.state).toBe("DELIVERED");
    expect(s.deliveredAtMs).toBe(700);
  });

  it("applies a customer refusal from out_for_delivery", () => {
    const s = run(created(), ev("out_for_delivery", 10), ev("customer_refused", 20));
    expect(s.state).toBe("RTO_INITIATED");
  });

  it("accepts a courier-driven rto after a failed attempt and finishes the return leg", () => {
    const s = run(created(), ...attempt(1), ev("rto_initiated", 800), ev("rto_delivered", 900));
    expect(s.state).toBe("RETURNED_TO_SELLER");
  });

  it("flags rto from a state that cannot take it", () => {
    const out = applyTracking(created(), ev("rto_initiated", 5));
    expect(out).toMatchObject({ kind: "ignored", reason: "invalid_transition" });
  });
});

describe("cancel, lost and wire status", () => {
  it("cancels only before pickup", () => {
    expect(run(created(), ev("cancelled")).state).toBe("CANCELLED");
    const afterPickup = run(created(), ev("picked_up", 5));
    expect(applyTracking(afterPickup, ev("cancelled", 6))).toMatchObject({ kind: "ignored", reason: "invalid_transition" });
  });

  it("marks lost from transit", () => {
    expect(run(created(), ev("picked_up", 1), ev("in_transit", 2), ev("lost", 3)).state).toBe("LOST");
  });

  it("maps every machine state to a wire status", () => {
    expect(toWireStatus("LABEL_PENDING")).toBe("label_pending");
    expect(toWireStatus("LABEL_CREATED")).toBe("label_ready");
    expect(toWireStatus("COD_REMITTED")).toBe("delivered");
    expect(toWireStatus("RTO_INITIATED")).toBe("rto");
    expect(toWireStatus("DELIVERY_ATTEMPT_FAILED")).toBe("delivery_failed");
  });

  it("applyAwbCreated is a no-op outside LABEL_PENDING", () => {
    const s = created();
    expect(applyAwbCreated(s)).toBe(s);
  });
});
