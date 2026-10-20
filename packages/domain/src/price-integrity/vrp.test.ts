import { describe, expect, it } from "vitest";
import {
  EXTERNAL_STALE_MS,
  MS_PER_DAY,
  computeVrp,
  discountPercent,
  normalizeEvents,
  toPriceBlock,
  toSnapshot,
  type ExternalEvidence,
  type PriceEvent,
} from "./index";
import { sanitizePriceBlock } from "../catalog/public-view";

const D = MS_PER_DAY;
const NOW = 200 * D;
let n = 0;
const ev = (price: number, dayStart: number, id?: string): PriceEvent => {
  n += 1;
  return { id: id ?? `e${n}`, skuId: "sku", priceAmount: BigInt(price), validFromMs: dayStart * D, source: "seller", actorId: null };
};
const ext = (over: Partial<ExternalEvidence> = {}): ExternalEvidence => ({
  id: "x1",
  lowPriceAmount: 800n,
  currentPriceAmount: null,
  matchConfBp: 9_500,
  historyDays: 45,
  observedAtMs: NOW - D,
  ...over,
});

describe("discountPercent", () => {
  it("floors on integer piastres", () => {
    expect(discountPercent(1000n, 900n)).toBe(10);
    expect(discountPercent(1000n, 951n)).toBe(4);
    expect(discountPercent(3n, 2n)).toBe(33);
  });
});

describe("normalizeEvents", () => {
  it("sorts, drops future and non-positive, collapses repeats", () => {
    const out = normalizeEvents([ev(5, 10, "c"), ev(100, 0, "a"), ev(100, 3, "b"), ev(0, 4, "z"), ev(9, 999, "f")], NOW);
    expect(out.map((e) => e.id)).toEqual(["a", "c"]);
  });
  it("is stable on equal timestamps by id", () => {
    const out = normalizeEvents([ev(5, 1, "b"), ev(6, 1, "a")], NOW);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("computeVrp", () => {
  it("no events: plain", () => {
    const r = computeVrp({ events: [], nowMs: NOW });
    expect(r).toMatchObject({ status: "none", priceAmount: null, claimAllowed: false, reason: "no_history" });
  });

  it("history under 30 days is a launch price, never a percentage", () => {
    const r = computeVrp({ events: [ev(1000, 180), ev(700, 195)], nowMs: NOW });
    expect(r.status).toBe("launch_price");
    expect(r.discountPct).toBeNull();
    expect(r.claimAllowed).toBe(false);
  });

  it("exactly 30 days of listing is no longer a launch price", () => {
    const r = computeVrp({ events: [ev(1000, 170)], nowMs: NOW });
    expect(r.status).toBe("none");
  });

  it("verified discount from internal low", () => {
    const r = computeVrp({ events: [ev(1000, 0, "a"), ev(800, 190, "b")], nowMs: NOW });
    expect(r).toMatchObject({ status: "verified_discount", vrpAmount: 1000n, discountPct: 20, claimAllowed: true, chainStartMs: 190 * D });
    expect(r.evidence.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("4 percent is below the 5 percent bar; exactly 5 passes", () => {
    expect(computeVrp({ events: [ev(1000, 0), ev(960, 190)], nowMs: NOW })).toMatchObject({ claimAllowed: false, discountPct: null, vrpAmount: null, reason: "below_threshold" });
    expect(computeVrp({ events: [ev(1000, 0), ev(950, 190)], nowMs: NOW })).toMatchObject({ status: "verified_discount", discountPct: 5 });
  });

  it("anti-inflation: raise then cut inside 30 days references the lower pre-raise price", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(1500, 180), ev(1200, 190)], nowMs: NOW });
    expect(r.status).not.toBe("verified_discount");
    expect(r.reason).toBe("reference_not_above_price");
    const r2 = computeVrp({ events: [ev(1000, 0), ev(1500, 180), ev(950, 190)], nowMs: NOW });
    expect(r2).toMatchObject({ status: "verified_discount", vrpAmount: 1000n, discountPct: 5, inflationReset: true });
  });

  it("a raise held for more than 30 days before the cut is a legitimate reference", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(1500, 100), ev(1200, 190)], nowMs: NOW });
    expect(r).toMatchObject({ status: "verified_discount", vrpAmount: 1500n, discountPct: 20, inflationReset: false });
  });

  it("successive discounts keep the starting reference while price never goes up", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(900, 185), ev(800, 192)], nowMs: NOW });
    expect(r).toMatchObject({ vrpAmount: 1000n, discountPct: 20, chainStartMs: 185 * D });
  });

  it("an increase between discounts restarts the run", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(900, 150), ev(950, 190), ev(800, 195)], nowMs: NOW });
    expect(r).toMatchObject({ vrpAmount: 900n, discountPct: 11, chainStartMs: 195 * D });
  });

  it("insufficient history before the cut fails closed", () => {
    const r = computeVrp({ events: [ev(1000, 170), ev(700, 185)], nowMs: NOW });
    expect(r).toMatchObject({ reason: "insufficient_history", claimAllowed: false, discountPct: null, vrpAmount: null });
  });

  it("a discount older than 30 days expires", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(700, 100)], nowMs: NOW });
    expect(r).toMatchObject({ status: "none", reason: "discount_expired" });
  });

  it("current price at or above its predecessor is not a reduction", () => {
    expect(computeVrp({ events: [ev(1000, 0), ev(1100, 190)], nowMs: NOW }).reason).toBe("not_a_reduction");
  });

  it("lowest in 30 days badge when a small cut fails the percentage bar but is the window low", () => {
    const r = computeVrp({ events: [ev(1000, 0), ev(960, 190)], nowMs: NOW });
    expect(r.status).toBe("lowest_30d");
    expect(r.discountPct).toBeNull();
    expect(r.vrpAmount).toBeNull();
  });

  it("a constant price is not a low", () => {
    expect(computeVrp({ events: [ev(1000, 0)], nowMs: NOW }).status).toBe("none");
  });

  describe("external evidence via the port", () => {
    it("takes the lower of internal and external", () => {
      const r = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ lowPriceAmount: 900n }) });
      expect(r).toMatchObject({ vrpAmount: 900n, discountPct: 22, externalUsed: true });
      expect(r.evidence.map((e) => e.kind)).toContain("external");
    });
    it("a higher external price never raises the reference", () => {
      const r = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ lowPriceAmount: 5000n }) });
      expect(r.vrpAmount).toBe(1000n);
      expect(r.externalUsed).toBe(false);
    });
    it("a low-confidence match is ignored", () => {
      const r = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ matchConfBp: 9_199, lowPriceAmount: 800n }) });
      expect(r.vrpAmount).toBe(1000n);
      expect(computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ matchConfBp: 9_200, lowPriceAmount: 800n }) }).vrpAmount).toBe(800n);
    });
    it("short channel history is ignored", () => {
      const r = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ historyDays: 29, lowPriceAmount: 100n }) });
      expect(r.vrpAmount).toBe(1000n);
    });
    it("stale evidence (over 72h) fails closed to a plain price", () => {
      const r = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ observedAtMs: NOW - EXTERNAL_STALE_MS - 1 }) });
      expect(r).toMatchObject({ status: "none", claimAllowed: false, reason: "stale_external_evidence" });
      const fresh = computeVrp({ events: [ev(1000, 0), ev(700, 190)], nowMs: NOW, external: ext({ observedAtMs: NOW - EXTERNAL_STALE_MS }) });
      expect(fresh.status).toBe("verified_discount");
    });
    it("flags cross-channel parity breach and blocks the low badge", () => {
      const r = computeVrp({
        events: [ev(1000, 0), ev(960, 190)],
        nowMs: NOW,
        external: ext({ lowPriceAmount: 900n, currentPriceAmount: 900n }),
      });
      expect(r.crossChannelCheaper).toBe(true);
      expect(r.status).toBe("none");
      expect(r.reason).toBe("reference_not_above_price");
    });
  });
});

describe("toPriceBlock / toSnapshot", () => {
  const verified = computeVrp({ events: [ev(1000, 0, "a"), ev(800, 190, "b")], nowMs: NOW });
  it("verified result becomes a legal block", () => {
    const b = toPriceBlock(verified, "claim-1");
    expect(b).toEqual({ badge: "verified_discount", referencePrice: { amount: 1000n, currency: "EGP" }, discountPct: 20, claimId: "claim-1" });
    expect(sanitizePriceBlock(b)).toEqual(b);
  });
  it("no claim id means no percentage", () => {
    expect(toPriceBlock(verified, null).badge).toBe("none");
  });
  it("plain and launch carry no reference", () => {
    const launch = computeVrp({ events: [ev(1000, 190)], nowMs: NOW });
    expect(toPriceBlock(launch, "c")).toEqual({ badge: "launch_price", referencePrice: null, discountPct: null, claimId: "c" });
    expect(toPriceBlock(computeVrp({ events: [], nowMs: NOW }), "c")).toEqual({ badge: "none", referencePrice: null, discountPct: null, claimId: null });
  });
  it("snapshot keeps evidence ids and drops vrp when no claim", () => {
    expect(toSnapshot(verified, NOW)).toEqual({
      priceAmount: 800n,
      vrpAmount: 1000n,
      discountPct: 20,
      claimType: "verified_discount",
      evidenceIds: ["a", "b"],
      computedAtMs: NOW,
    });
    const plain = toSnapshot(computeVrp({ events: [ev(1000, 0)], nowMs: NOW }), NOW);
    expect(plain.vrpAmount).toBeNull();
    expect(plain.discountPct).toBeNull();
  });
});

import { detectPreDropInflation } from "./index";
describe("detectPreDropInflation", () => {
  it("flags a raise inside the 30 days before a cut", () => {
    expect(detectPreDropInflation([ev(1000, 0), ev(1500, 180), ev(1200, 190)], NOW)).toBe(true);
  });
  it("does not flag a raise older than the window or a plain cut", () => {
    expect(detectPreDropInflation([ev(1000, 0), ev(1500, 100), ev(1200, 190)], NOW)).toBe(false);
    expect(detectPreDropInflation([ev(1000, 0), ev(800, 190)], NOW)).toBe(false);
    expect(detectPreDropInflation([ev(1000, 0), ev(1500, 190)], NOW)).toBe(false);
    expect(detectPreDropInflation([], NOW)).toBe(false);
  });
});
