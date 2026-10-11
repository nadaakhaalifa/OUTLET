import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MS_PER_DAY, WINDOW_MS, computeVrp, normalizeEvents, toPriceBlock, type PriceEvent } from "./index";

const D = MS_PER_DAY;
const mk = (i: number, price: number, atMs: number): PriceEvent => ({
  id: `p${i}`,
  skuId: "s",
  priceAmount: BigInt(price),
  validFromMs: atMs,
  source: "seller",
  actorId: null,
});

/** Random history: 1..8 changes at hour granularity over 120 days, ending at `now`. */
const history = fc
  .record({
    steps: fc.array(fc.record({ gapHours: fc.integer({ min: 1, max: 24 * 20 }), price: fc.integer({ min: 100, max: 20_000 }) }), {
      minLength: 1,
      maxLength: 8,
    }),
    tailHours: fc.integer({ min: 0, max: 24 * 40 }),
  })
  .map(({ steps, tailHours }) => {
    let t = 0;
    const events: PriceEvent[] = [];
    steps.forEach((s, i) => {
      t += s.gapHours * 3_600_000;
      events.push(mk(i, s.price, t));
    });
    return { events, now: t + tailHours * 3_600_000 };
  });

/** Independent oracle: lowest price in force during [from, to), by direct interval intersection. */
function lowestInForce(events: readonly PriceEvent[], from: number, to: number): bigint | null {
  const sorted = normalizeEvents(events, Number.MAX_SAFE_INTEGER);
  let best: bigint | null = null;
  sorted.forEach((e, i) => {
    const until = sorted[i + 1]?.validFromMs ?? Number.POSITIVE_INFINITY;
    if (e.validFromMs < to && until > from && (best === null || e.priceAmount < best)) best = e.priceAmount;
  });
  return best;
}

describe("computeVrp properties", () => {
  it("a verified claim never references above the true lowest price of the 30 days before the run began", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ gapHours: fc.integer({ min: 1, max: 24 * 25 }), price: fc.integer({ min: 100, max: 20_000 }) }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 24 * 35 }),
        (steps, tailHours) => {
          let t = 0;
          const events = steps.map((s, i) => {
            t += s.gapHours * 3_600_000;
            return mk(i, s.price, t);
          });
          const now = t + tailHours * 3_600_000;
          const r = computeVrp({ events, nowMs: now });
          if (r.status !== "verified_discount" || r.chainStartMs === null || r.vrpAmount === null || r.priceAmount === null) return;
          const truth = lowestInForce(events, r.chainStartMs - WINDOW_MS, r.chainStartMs);
          expect(truth).not.toBeNull();
          expect(r.vrpAmount).toBe(truth);
          expect(r.vrpAmount > r.priceAmount).toBe(true);
          expect(r.discountPct).not.toBeNull();
          expect(r.discountPct).toBeGreaterThanOrEqual(5);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a price raised then cut within 30 days never claims above the pre-raise price", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000 }), // base
        fc.integer({ min: 1, max: 10_000 }), // raise delta
        fc.integer({ min: 50, max: 15_000 }), // cut price
        fc.integer({ min: 1, max: 29 * 24 }), // hours between raise and cut (< 30 days)
        fc.integer({ min: 0, max: 24 * 29 }), // hours between the cut and now
        (base, delta, cut, gapHours, tail) => {
          const raiseAt = 60 * D;
          const cutAt = raiseAt + gapHours * 3_600_000;
          const events = [mk(0, base, 0), mk(1, base + delta, raiseAt), mk(2, cut, cutAt)];
          const r = computeVrp({ events, nowMs: cutAt + tail * 3_600_000 });
          if (r.status === "verified_discount") {
            expect(r.vrpAmount !== null && r.vrpAmount <= BigInt(base)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never a percentage without evidence: any history shorter than 30 days yields none or launch", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 20_000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 30 * 24 - 1 }),
        (prices, spanHours) => {
          const events = prices.map((p, i) => mk(i, p, Math.floor((spanHours * 3_600_000 * i) / prices.length)));
          const r = computeVrp({ events, nowMs: spanHours * 3_600_000 });
          expect(r.status === "launch_price" || r.status === "none").toBe(true);
          expect(r.discountPct).toBeNull();
          expect(r.claimAllowed).toBe(false);
          expect(toPriceBlock(r, "c").referencePrice).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("any output with a percentage carries a reference above the price and non-empty evidence", () => {
    fc.assert(
      fc.property(history, ({ events, now }) => {
        const r = computeVrp({ events, nowMs: now });
        if (r.discountPct !== null) {
          expect(r.claimAllowed).toBe(true);
          expect(r.vrpAmount).not.toBeNull();
          expect(r.evidence.length).toBeGreaterThan(0);
          expect(r.discountPct).toBeGreaterThanOrEqual(5);
          expect(r.discountPct).toBeLessThanOrEqual(99);
        } else {
          expect(r.claimAllowed).toBe(false);
          expect(r.status).not.toBe("verified_discount");
        }
      }),
      { numRuns: 400 },
    );
  });

  it("is a pure function of its input and ignores event order and future events", () => {
    fc.assert(
      fc.property(history, ({ events, now }) => {
        const a = computeVrp({ events, nowMs: now });
        const b = computeVrp({ events: [...events].reverse(), nowMs: now });
        const c = computeVrp({ events: [...events, mk(99, 1, now + 1)], nowMs: now });
        expect(b).toEqual(a);
        expect(c).toEqual(a);
      }),
      { numRuns: 200 },
    );
  });
});
