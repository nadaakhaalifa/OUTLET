import { describe, expect, it } from "vitest";
import {
  EXTERNAL_STALE_MS,
  MS_PER_DAY,
  computeVrp,
  detectPreDropInflation,
  normalizeEvents,
  toPriceBlock,
  type ExternalEvidence,
  type PriceEvent,
  type VrpResult,
} from "./index";

// Boundary and exact-shape tests for the VRP (spec 9.3). Day numbers are absolute; 30-day window = 30 * D.
const D = MS_PER_DAY;
const e = (id: string, price: number, day: number): PriceEvent => ({
  id,
  skuId: "sku",
  priceAmount: BigInt(price),
  validFromMs: day * D,
  source: "seller",
  actorId: null,
});
const xe = (over: Partial<ExternalEvidence> = {}, nowMs = 110 * D): ExternalEvidence => ({
  id: "x1",
  lowPriceAmount: 950n,
  currentPriceAmount: null,
  matchConfBp: 9_200,
  historyDays: 30,
  observedAtMs: nowMs - D,
  ...over,
});
const pe = (id: string) => ({ kind: "price_event", id });

describe("normalizeEvents ordering", () => {
  it("includes an event valid exactly now", () => {
    expect(normalizeEvents([e("x", 5, 200)], 200 * D).map((v) => v.id)).toEqual(["x"]);
  });
  it("orders equal timestamps by id under every input permutation", () => {
    const a = e("a", 1, 5);
    const b = e("b", 2, 5);
    const c = e("c", 3, 5);
    const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    for (const p of perms) expect(normalizeEvents(p, 9 * D).map((v) => v.id)).toEqual(["a", "b", "c"]);
  });
  it("orders by time before id", () => {
    expect(normalizeEvents([e("a", 1, 6), e("z", 2, 5)], 9 * D).map((v) => v.id)).toEqual(["z", "a"]);
  });
});

describe("reference window boundaries", () => {
  const now = 110 * D;
  it("a price replaced exactly at the window start is not in force during it", () => {
    const r = computeVrp({ events: [e("lo", 400, 0), e("hi", 1000, 70), e("cur", 900, 100)], nowMs: now });
    expect(r.vrpAmount).toBe(1000n);
    expect(r.evidence).toEqual([pe("hi"), pe("cur")]);
    expect(r.discountPct).toBe(10);
  });
  it("a price that ended long before the window is ignored", () => {
    const r = computeVrp({ events: [e("lo", 400, 0), e("hi", 1000, 10), e("cur", 900, 100)], nowMs: now });
    expect(r.vrpAmount).toBe(1000n);
  });
  it("history starting exactly at the window start is enough", () => {
    const r = computeVrp({ events: [e("a", 1000, 70), e("cur", 900, 100)], nowMs: now });
    expect(r.status).toBe("verified_discount");
    expect(r.vrpAmount).toBe(1000n);
  });
  it("successive discounts keep the starting reference and raise no inflation reset", () => {
    const r = computeVrp({ events: [e("a", 1000, 0), e("b", 950, 80), e("c", 800, 100)], nowMs: now });
    expect(r).toMatchObject({ vrpAmount: 1000n, discountPct: 20, inflationReset: false, chainStartMs: 80 * D });
    expect(r.evidence).toEqual([pe("a"), pe("c")]);
  });
  it("an increase in the window lowers the reference and flags the reset", () => {
    const r = computeVrp({ events: [e("a", 800, 0), e("b", 1000, 80), e("c", 700, 100)], nowMs: now });
    expect(r).toMatchObject({ vrpAmount: 800n, discountPct: 12, inflationReset: true, claimAllowed: true });
    expect(r.evidence).toEqual([pe("a"), pe("c")]);
  });
  it("ties on the minimum keep the earliest event as evidence", () => {
    const r = computeVrp({
      events: [e("A", 900, 65), e("B", 1000, 75), e("C", 900, 80), e("D", 1100, 90), e("E", 1000, 100), e("P", 800, 102)],
      nowMs: now,
    });
    expect(r).toMatchObject({ vrpAmount: 900n, discountPct: 11, chainStartMs: 100 * D });
    expect(r.evidence).toEqual([pe("A"), pe("P")]);
  });
  it("a run of reductions starts after the last increase, not before it", () => {
    const r = computeVrp({ events: [e("a", 500, 0), e("b", 1000, 50), e("c", 900, 90), e("d", 800, 100)], nowMs: now });
    expect(r).toMatchObject({ vrpAmount: 1000n, discountPct: 20, chainStartMs: 90 * D });
    expect(r.evidence).toEqual([pe("b"), pe("d")]);
  });
  it("a discount started exactly 30 days ago is still claimable; one millisecond later it expired", () => {
    const events = [e("a", 1000, 0), e("b", 900, 170)];
    expect(computeVrp({ events, nowMs: 200 * D }).status).toBe("verified_discount");
    const late = computeVrp({ events, nowMs: 200 * D + 1 });
    expect(late).toMatchObject({ status: "none", claimAllowed: false, reason: "discount_expired" });
  });
  it("exactly 30 days of listing is no longer a launch price; one millisecond less is", () => {
    expect(computeVrp({ events: [e("a", 1000, 170)], nowMs: 200 * D }).status).toBe("none");
    expect(computeVrp({ events: [e("a", 1000, 170)], nowMs: 200 * D - 1 }).status).toBe("launch_price");
  });
  it("launch price has the exact plain shape", () => {
    expect(computeVrp({ events: [e("a", 1000, 181), e("b", 900, 190)], nowMs: 200 * D })).toEqual({
      status: "launch_price",
      priceAmount: 900n,
      vrpAmount: null,
      discountPct: null,
      claimAllowed: false,
      reason: "launch_window",
      inflationReset: false,
      chainStartMs: null,
      evidence: [pe("a")],
      externalUsed: false,
      crossChannelCheaper: false,
    });
  });
  it("a reference equal to the price is not above it", () => {
    const r = computeVrp({ events: [e("a", 800, 0), e("b", 1000, 85), e("c", 800, 100)], nowMs: now });
    expect(r).toMatchObject({ status: "lowest_30d", claimAllowed: false, reason: "reference_not_above_price", discountPct: null });
    expect(r.evidence).toEqual([pe("c")]);
  });
  it("exactly 5 percent is claimable, 4 is not", () => {
    expect(computeVrp({ events: [e("a", 1000, 0), e("b", 950, 100)], nowMs: now })).toMatchObject({ claimAllowed: true, discountPct: 5 });
    expect(computeVrp({ events: [e("a", 1000, 0), e("b", 951, 100)], nowMs: now })).toMatchObject({ claimAllowed: false, reason: "below_threshold" });
  });
});

describe("external evidence", () => {
  const now = 110 * D;
  const base = [e("b0", 1000, 0), e("b1", 900, 100)];
  it("is used when it is the strictest, and recorded in the trail", () => {
    const r = computeVrp({ events: base, nowMs: now, external: xe() });
    expect(r).toMatchObject({ vrpAmount: 950n, discountPct: 5, externalUsed: true });
    expect(r.evidence).toEqual([pe("b0"), { kind: "external", id: "x1" }, pe("b1")]);
  });
  it("equal to the internal reference is evidence but not used", () => {
    const r = computeVrp({ events: base, nowMs: now, external: xe({ lowPriceAmount: 1000n }) });
    expect(r).toMatchObject({ vrpAmount: 1000n, externalUsed: false });
    expect(r.evidence).toEqual([pe("b0"), { kind: "external", id: "x1" }, pe("b1")]);
  });
  it("is ignored below tau, below 30 days of history, with a zero price or a fractional confidence", () => {
    for (const over of [{ matchConfBp: 9_199 }, { historyDays: 29 }, { lowPriceAmount: 0n }, { matchConfBp: 9_500.5 }]) {
      const r = computeVrp({ events: base, nowMs: now, external: xe(over) });
      expect(r).toMatchObject({ vrpAmount: 1000n, externalUsed: false, claimAllowed: true });
      expect(r.evidence).toEqual([pe("b0"), pe("b1")]);
    }
  });
  it("null external behaves as absent", () => {
    expect(computeVrp({ events: base, nowMs: now, external: null }).vrpAmount).toBe(1000n);
  });
  it("is fresh at exactly 72h and stale one millisecond later (fail closed)", () => {
    const fresh = computeVrp({ events: base, nowMs: now, external: xe({ observedAtMs: now - EXTERNAL_STALE_MS }) });
    expect(fresh.externalUsed).toBe(true);
    const stale = computeVrp({ events: base, nowMs: now, external: xe({ observedAtMs: now - EXTERNAL_STALE_MS - 1 }) });
    expect(stale).toMatchObject({ status: "none", claimAllowed: false, reason: "stale_external_evidence", vrpAmount: null });
  });
  it("cross-channel parity needs a fresh, matched, positive and strictly lower price", () => {
    const cc = (over: Partial<ExternalEvidence>) => computeVrp({ events: base, nowMs: now, external: xe(over) }).crossChannelCheaper;
    expect(cc({ currentPriceAmount: 899n })).toBe(true);
    expect(cc({ currentPriceAmount: 900n })).toBe(false);
    expect(cc({ currentPriceAmount: 901n })).toBe(false);
    expect(cc({ currentPriceAmount: 0n })).toBe(false);
    expect(cc({ currentPriceAmount: null })).toBe(false);
    expect(cc({ currentPriceAmount: 800n, observedAtMs: now - EXTERNAL_STALE_MS - 1 })).toBe(false);
    expect(cc({ currentPriceAmount: 800n, matchConfBp: 9_000 })).toBe(false);
  });
});

describe("lowest price in 30 days", () => {
  it("applies when history only just covers the window", () => {
    const r = computeVrp({ events: [e("f", 1000, 170), e("g", 900, 190)], nowMs: 200 * D });
    expect(r).toMatchObject({ status: "lowest_30d", claimAllowed: false, reason: "insufficient_history", discountPct: null });
    expect(r.evidence).toEqual([pe("g")]);
  });
  it("counts a price that took effect exactly now", () => {
    const r = computeVrp({ events: [e("f", 1000, 150), e("g", 970, 200)], nowMs: 200 * D });
    expect(r).toMatchObject({ status: "lowest_30d", reason: "below_threshold" });
    expect(r.evidence).toEqual([pe("g")]);
  });
  it("is blocked by stale external evidence", () => {
    const r = computeVrp({
      events: [e("f", 1000, 150), e("g", 900, 190)],
      nowMs: 200 * D,
      external: xe({ observedAtMs: 200 * D - EXTERNAL_STALE_MS - 1 }, 200 * D),
    });
    expect(r).toMatchObject({ status: "none", reason: "stale_external_evidence" });
  });
  it("is blocked by a strictly cheaper external low, not by an equal one", () => {
    const events = [e("f", 1000, 150), e("g", 970, 200)];
    const now = 200 * D;
    expect(computeVrp({ events, nowMs: now, external: xe({ lowPriceAmount: 960n }, now) }).status).toBe("none");
    expect(computeVrp({ events, nowMs: now, external: xe({ lowPriceAmount: 970n }, now) }).status).toBe("lowest_30d");
  });
  it("needs a higher price in the window and the current price to be the lowest", () => {
    expect(computeVrp({ events: [e("a", 1000, 100)], nowMs: 200 * D })).toMatchObject({ status: "none", reason: "not_a_reduction" });
    expect(computeVrp({ events: [e("a", 1000, 150), e("b", 900, 170), e("c", 950, 190)], nowMs: 200 * D }).status).toBe("none");
  });
});

describe("toPriceBlock mapping", () => {
  const verified = computeVrp({ events: [e("a", 1000, 0), e("b", 900, 100)], nowMs: 110 * D });
  const none: VrpResult = { ...verified, status: "none", claimAllowed: false, vrpAmount: null, discountPct: null };
  it("shows a percentage only for a fully verified claim with a claim id", () => {
    expect(toPriceBlock(verified, "c1")).toEqual({
      badge: "verified_discount",
      referencePrice: { amount: 1000n, currency: "EGP" },
      discountPct: 10,
      claimId: "c1",
    });
    expect(toPriceBlock(verified, null).badge).toBe("none");
    expect(toPriceBlock({ ...verified, claimAllowed: false }, "c1").badge).toBe("none");
    expect(toPriceBlock({ ...verified, vrpAmount: null }, "c1").badge).toBe("none");
    expect(toPriceBlock({ ...verified, discountPct: null }, "c1").badge).toBe("none");
    expect(toPriceBlock({ ...verified, status: "none" }, "c1").badge).toBe("none");
  });
  it("maps lowest and launch badges without a reference price", () => {
    expect(toPriceBlock({ ...none, status: "lowest_30d" }, "c2")).toEqual({ badge: "lowest_30d", referencePrice: null, discountPct: null, claimId: "c2" });
    expect(toPriceBlock({ ...none, status: "launch_price" }, "c3")).toEqual({ badge: "launch_price", referencePrice: null, discountPct: null, claimId: "c3" });
    expect(toPriceBlock(none, "c4")).toEqual({ badge: "none", referencePrice: null, discountPct: null, claimId: null });
  });
});

describe("detectPreDropInflation", () => {
  const now = 110 * D;
  it("is false without a current reduction", () => {
    expect(detectPreDropInflation([], now)).toBe(false);
    expect(detectPreDropInflation([e("a", 1000, 0)], now)).toBe(false);
    expect(detectPreDropInflation([e("a", 500, 0), e("b", 1000, 80), e("c", 1100, 100)], now)).toBe(false);
  });
  it("is true only when the price rose inside the 30 days before the run began", () => {
    expect(detectPreDropInflation([e("a", 800, 0), e("b", 1000, 80), e("c", 700, 100)], now)).toBe(true);
    expect(detectPreDropInflation([e("a", 1000, 0), e("b", 950, 80), e("c", 800, 100)], now)).toBe(false);
    expect(detectPreDropInflation([e("a", 800, 0), e("b", 1000, 20), e("c", 700, 100)], now)).toBe(false);
  });
});

describe("enforcement look-back constant", () => {
  it("is exactly 90 days in milliseconds", async () => {
    const m = await import("./enforcement");
    expect(m.VIOLATION_LOOKBACK_MS).toBe(90 * MS_PER_DAY);
  });
});
