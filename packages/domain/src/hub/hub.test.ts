import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUB_CONFIG,
  InvalidLegTransitionError,
  LEG_STATES,
  LEG_TRANSITIONS,
  MS_PER_HOUR,
  canMoveLeg,
  chooseCourier,
  compareConsolidation,
  estimateLegGco2e,
  estimateParcelGco2e,
  handoffOverdue,
  isTerminalLeg,
  moveLeg,
  p80,
  planConsolidation,
  splitFee,
  type CourierCandidate,
  type HubLeg,
  type LegState,
} from "./index";

const leg = (id: string, state: LegState, lines: string[], subtotal = 1000n): HubLeg => ({
  sellerOrderId: id,
  state,
  lineIds: lines,
  subtotal,
});
const PAID = 1_000_000_000;

describe("leg state machine", () => {
  it("walks the happy path and rejects everything else", () => {
    expect(moveLeg("AT_HUB_EXPECTED", "RECEIVED")).toBe("RECEIVED");
    expect(moveLeg("RECEIVED", "CONSOLIDATED")).toBe("CONSOLIDATED");
    expect(moveLeg("CONSOLIDATED", "DISPATCHED")).toBe("DISPATCHED");
    expect(() => moveLeg("AT_HUB_EXPECTED", "DISPATCHED")).toThrow(InvalidLegTransitionError);
    expect(() => moveLeg("DISPATCHED", "RECEIVED")).toThrow(InvalidLegTransitionError);
  });
  it("every state is reachable and terminals have no exits", () => {
    const seen = new Set<LegState>(["AT_HUB_EXPECTED"]);
    const q: LegState[] = ["AT_HUB_EXPECTED"];
    while (q.length > 0) {
      const s = q.pop() as LegState;
      for (const n of LEG_TRANSITIONS[s]) {
        if (seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    expect([...seen].sort()).toEqual([...LEG_STATES].sort());
    for (const s of ["DISPATCHED", "CANCELLED", "EXCEPTION"] as const) expect(isTerminalLeg(s)).toBe(true);
    expect(canMoveLeg("RECEIVED", "CONSOLIDATED")).toBe(true);
  });
  it("flags handoff overdue only while still expected", () => {
    const sla = DEFAULT_HUB_CONFIG.handoffSlaMs;
    expect(handoffOverdue("AT_HUB_EXPECTED", PAID, PAID + sla, sla)).toBe(false);
    expect(handoffOverdue("AT_HUB_EXPECTED", PAID, PAID + sla + 1, sla)).toBe(true);
    expect(handoffOverdue("RECEIVED", PAID, PAID + sla * 3, sla)).toBe(false);
  });
});

describe("planConsolidation", () => {
  const base = { shipTogether: true, paidAtMs: PAID, deliveryFee: 6000n };
  it("three sellers received: one parcel, one fee", () => {
    const d = planConsolidation({
      ...base,
      nowMs: PAID + 10 * MS_PER_HOUR,
      legs: [leg("a", "RECEIVED", ["a1"]), leg("b", "RECEIVED", ["b1", "b2"]), leg("c", "RECEIVED", ["c1"])],
    });
    expect(d.kind).toBe("dispatch");
    if (d.kind !== "dispatch") return;
    expect(d.parcels).toHaveLength(1);
    expect(d.parcels[0]?.shopperFee).toBe(6000n);
    expect(d.parcels[0]?.lineIds).toEqual(["a1", "b1", "b2", "c1"]);
    expect(d.split).toBe(false);
  });
  it("waits for a late seller inside the window", () => {
    const d = planConsolidation({
      ...base,
      nowMs: PAID + 71 * MS_PER_HOUR,
      legs: [leg("a", "RECEIVED", ["a1"]), leg("b", "AT_HUB_EXPECTED", ["b1"])],
    });
    expect(d).toMatchObject({ kind: "wait", reason: "awaiting_all_legs", waitingForSellerOrderIds: ["b"] });
  });
  it("splits at 72 h and the second parcel is free", () => {
    const legs = [leg("a", "RECEIVED", ["a1"]), leg("b", "AT_HUB_EXPECTED", ["b1"])];
    const d = planConsolidation({ ...base, nowMs: PAID + 72 * MS_PER_HOUR, legs });
    expect(d).toMatchObject({ kind: "dispatch", split: true, lateSellerOrderIds: ["b"] });
    // later: b arrives, a already dispatched
    const later = planConsolidation({
      ...base,
      nowMs: PAID + 90 * MS_PER_HOUR,
      legs: [leg("a", "DISPATCHED", ["a1"]), leg("b", "RECEIVED", ["b1"])],
    });
    expect(later.kind === "dispatch" && later.parcels[0]?.shopperFee).toBe(0n);
  });
  it("ships what is ready at once when ship-together is off", () => {
    const d = planConsolidation({
      ...base,
      shipTogether: false,
      nowMs: PAID + MS_PER_HOUR,
      legs: [leg("a", "RECEIVED", ["a1"]), leg("b", "AT_HUB_EXPECTED", ["b1"])],
    });
    expect(d.kind).toBe("dispatch");
  });
  it("nothing to do for assigned or dead legs, wait when nothing arrived", () => {
    expect(planConsolidation({ ...base, nowMs: PAID, legs: [leg("a", "CONSOLIDATED", []), leg("b", "CANCELLED", [])] })).toEqual({ kind: "nothing" });
    expect(planConsolidation({ ...base, nowMs: PAID + 100 * MS_PER_HOUR, legs: [leg("a", "AT_HUB_EXPECTED", ["a1"])] }).kind).toBe("wait");
  });
  it("rejects duplicates and negative fees", () => {
    expect(() => planConsolidation({ ...base, nowMs: PAID, legs: [leg("a", "RECEIVED", []), leg("a", "RECEIVED", [])] })).toThrow();
    expect(() => planConsolidation({ ...base, deliveryFee: -1n, nowMs: PAID, legs: [leg("a", "RECEIVED", [])] })).toThrow();
  });
});

describe("planner properties", () => {
  const legArb = fc
    .array(
      fc.record({
        state: fc.constantFrom<LegState>(...LEG_STATES),
        n: fc.integer({ min: 0, max: 4 }),
        subtotal: fc.bigInt({ min: 0n, max: 1_000_000n }),
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((xs) =>
      xs.map((x, i): HubLeg => ({
        sellerOrderId: `so${i}`,
        state: x.state,
        subtotal: x.subtotal,
        lineIds: Array.from({ length: x.n }, (_, j) => `so${i}-l${j}`),
      })),
    );
  it("every shipped line is in exactly one parcel; the fee is charged at most once and allocation sums to it", () => {
    fc.assert(
      fc.property(
        legArb,
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 200 }),
        (legs, together, fee, hours) => {
          const d = planConsolidation({
            legs,
            shipTogether: together,
            deliveryFee: fee,
            paidAtMs: PAID,
            nowMs: PAID + hours * MS_PER_HOUR,
          });
          if (d.kind !== "dispatch") return true;
          const all = d.parcels.flatMap((p) => p.lineIds);
          expect(new Set(all).size).toBe(all.length);
          const expected = legs.filter((l) => l.state === "RECEIVED").flatMap((l) => l.lineIds);
          expect([...all].sort()).toEqual([...expected].sort());
          const charged = d.parcels.reduce((s, p) => s + p.shopperFee, 0n);
          const alreadyPaid = legs.some((l) => l.state === "DISPATCHED");
          expect(charged).toBe(alreadyPaid ? 0n : fee);
          const alloc = Object.values(d.feeAllocation).reduce((s, v) => s + v, 0n);
          expect(alloc).toBe(fee);
          return true;
        },
      ),
    );
  });
  it("splitFee sums to the total with non-negative parts", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 12 }),
        (total, ws) => {
          const parts = splitFee(total, ws);
          expect(parts.reduce((s, p) => s + p, 0n)).toBe(total);
          expect(parts.every((p) => p >= 0n)).toBe(true);
          expect(parts).toHaveLength(ws.length);
        },
      ),
    );
  });
});

describe("carbon estimate", () => {
  it("is integer, labelled an estimate and monotonic in distance", () => {
    expect(estimateLegGco2e(0, 500)).toBe(0n);
    expect(estimateLegGco2e(300, 1000)).toBe(150n);
    const a = estimateParcelGco2e([{ distanceKm: 100, weightG: 1000 }]);
    const b = estimateParcelGco2e([{ distanceKm: 200, weightG: 1000 }]);
    expect(a).toMatchObject({ isEstimate: true, method: "distance_estimate" });
    expect(b.gCo2e > a.gCo2e).toBe(true);
    expect(() => estimateLegGco2e(1.5, 10)).toThrow();
    expect(() => estimateLegGco2e(-1, 10)).toThrow();
  });
  it("reports consolidation saving, which can be negative", () => {
    const orders = [1, 2, 3].map(() => ({ sellerToHubKm: 20, sellerToShopperKm: 200, weightG: 800 }));
    const r = compareConsolidation(orders, 180, undefined);
    expect(r.savedGco2e).toBe(r.separate.gCo2e - r.consolidated.gCo2e);
    expect(r.savedGco2e > 0n).toBe(true);
    const bad = compareConsolidation([{ sellerToHubKm: 300, sellerToShopperKm: 10, weightG: 800 }], 300);
    expect(bad.savedGco2e < 0n).toBe(true);
  });
});

describe("courier choice", () => {
  const c = (code: string, o: Partial<CourierCandidate> = {}): CourierCandidate => ({
    code,
    coversGovernorate: true,
    available: true,
    costPiastres: 5000n,
    p80TransitHours: 48,
    isDefault: false,
    ...o,
  });
  it("prefers the seller, then the default, then fails over", () => {
    expect(chooseCourier([c("bosta", { isDefault: true }), c("aramex")], "aramex")).toMatchObject({ code: "aramex", reason: "seller_preference" });
    expect(chooseCourier([c("bosta", { isDefault: true }), c("aramex")], null)).toMatchObject({ code: "bosta", reason: "default" });
    expect(chooseCourier([c("bosta", { isDefault: true, available: false }), c("aramex")], null)).toMatchObject({ code: "aramex", reason: "failover" });
  });
  it("returns typed none when uncovered or all down", () => {
    expect(chooseCourier([c("bosta", { coversGovernorate: false })], null)).toEqual({ kind: "none", reason: "not_covered" });
    expect(chooseCourier([c("bosta", { available: false })], null)).toEqual({ kind: "none", reason: "all_unavailable" });
  });
  it("computes the p80 by nearest rank", () => {
    expect(p80([])).toBeNull();
    expect(p80([10, 20, 30, 40, 50])).toBe(40);
    expect(p80([5])).toBe(5);
  });
});
