import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIMIZER_CONFIG,
  SLOTS,
  checkOutfit,
  colourHarmony,
  embeddingSimilarity,
  isModestCompliant,
  optimizeOutfits,
  pairCompat,
  planCapsule,
  rulesOutfits,
  updateStyleVector,
  type Candidate,
  type OutfitRequest,
  type Slot,
} from "./index";

const COLORS = ["black", "white", "red", "olive", "blue", "orange", "pink", "teal", "yellow"] as const;
const STORES = ["s1", "s2", "s3", "s4"] as const;

const cand = (id: string, slot: Slot, price: number, over: Partial<Candidate> = {}): Candidate => ({
  itemId: id,
  storeId: "s1",
  slot,
  pricePiastres: BigInt(price) * 100n,
  verifiedDiscountPct: 0,
  colors: ["black"],
  formality: 2,
  seasons: ["all"],
  coverage: { sleeve: "long", neckline: "high", length: "maxi" },
  popularity: 500,
  inSize: true,
  ...over,
});

const REQ: OutfitRequest = {
  budgetPiastres: 300_000n,
  occasionFormality: 2,
  season: "summer",
  modest: false,
  scopedToSingleStore: false,
  freeDeliveryThresholdPiastres: 200_000n,
  styleVector: null,
  locked: [],
};

const catalog = (): Candidate[] => {
  const out: Candidate[] = [];
  const stores = ["a", "b", "c"];
  for (const slot of SLOTS) {
    for (let i = 0; i < 4; i++) {
      out.push(cand(`${slot}-${i}`, slot, 100 + i * 150, { storeId: stores[(i + slot.length) % 3] as string, popularity: 300 + i * 100 }));
    }
  }
  return out;
};

describe("compat rules", () => {
  it("neutral colours pair with anything, clashes score low", () => {
    expect(colourHarmony(["black"], ["red"])).toBe(1000);
    expect(colourHarmony(["red"], ["orange"])).toBe(300);
    expect(colourHarmony(["red"], ["olive"])).toBe(700);
  });
  it("formality gap of 3 forbids the pair", () => {
    expect(pairCompat(cand("a", "top", 1, { formality: 0 }), cand("b", "shoes", 1, { formality: 3 }), "all")).toBeNull();
  });
  it("embedding similarity is neutral when missing and bounded", () => {
    expect(embeddingSimilarity(undefined, [1, 0])).toBe(500);
    expect(embeddingSimilarity([1, 0], [1, 0])).toBe(1000);
    expect(embeddingSimilarity([1, 0], [-1, 0])).toBe(0);
  });
  it("modest needs elbow sleeves, no low neckline, midi hem", () => {
    expect(isModestCompliant({ sleeve: "long", neckline: "high", length: "maxi" })).toBe(true);
    expect(isModestCompliant({ sleeve: "short", neckline: "high", length: "maxi" })).toBe(false);
    expect(isModestCompliant({ sleeve: "long", neckline: "low", length: "maxi" })).toBe(false);
    expect(isModestCompliant({ sleeve: "n/a", neckline: "n/a", length: "n/a" })).toBe(true);
    expect(isModestCompliant({ sleeve: "long", neckline: "high", length: "mini" })).toBe(false);
  });
});

describe("optimizer", () => {
  it("returns 3-5 complete diverse outfits within budget, in size, modest", () => {
    const items = catalog().map((c, i) => (i % 5 === 0 ? { ...c, inSize: false } : c));
    const req = { ...REQ, budgetPiastres: 3_000_00n * 10n, modest: true };
    const r = optimizeOutfits({ candidates: items, request: req });
    expect(r.outfits.length).toBeGreaterThanOrEqual(3);
    expect(r.outfits.length).toBeLessThanOrEqual(5);
    for (const o of r.outfits) {
      expect(o.complete).toBe(true);
      expect(o.totalPiastres <= 3_000_000n).toBe(true);
      expect(checkOutfit(o.items, req)).toEqual([]);
    }
    for (let i = 0; i < r.outfits.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = r.outfits[i]!;
        const b = r.outfits[j]!;
        const diff = SLOTS.filter((s) => a.items.find((x) => x.slot === s)?.itemId !== b.items.find((x) => x.slot === s)?.itemId).length;
        expect(diff).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("is deterministic", () => {
    const a = optimizeOutfits({ candidates: catalog(), request: { ...REQ, budgetPiastres: null } });
    const b = optimizeOutfits({ candidates: [...catalog()].reverse(), request: { ...REQ, budgetPiastres: null } });
    expect(a.outfits.map((o) => o.items.map((i) => i.itemId))).toEqual(b.outfits.map((o) => o.items.map((i) => i.itemId)));
  });

  it("caps two items per store unless scoped to one store", () => {
    const one = catalog().map((c) => ({ ...c, storeId: "only" }));
    const r = optimizeOutfits({ candidates: one, request: { ...REQ, budgetPiastres: null } });
    expect(r.outfits.every((o) => !o.complete)).toBe(true);
    const scoped = optimizeOutfits({ candidates: one, request: { ...REQ, budgetPiastres: null, scopedToSingleStore: true } });
    expect(scoped.outfits.length).toBeGreaterThan(0);
    expect(scoped.outfits.every((o) => o.complete)).toBe(true);
  });

  it("returns a partial outfit with an add-X amount when the budget is too low for shoes", () => {
    const items = catalog().filter((c) => c.slot !== "shoes").concat([cand("shoe-x", "shoes", 900, { storeId: "z" })]);
    const req = { ...REQ, budgetPiastres: 80_000n };
    const r = optimizeOutfits({ candidates: items, request: req });
    const o = r.outfits[0];
    expect(o).toBeDefined();
    expect(o!.complete).toBe(false);
    expect(o!.totalPiastres <= 80_000n).toBe(true);
    const shoes = o!.missing.find((m) => m.slot === "shoes");
    expect(shoes?.reason).toBe("budget");
    expect((shoes?.addPiastres ?? 0n) > 0n).toBe(true);
  });

  it("explains when no item exists in the size", () => {
    const items = catalog().map((c) => (c.slot === "bag" ? { ...c, inSize: false } : c));
    const r = optimizeOutfits({ candidates: items, request: { ...REQ, budgetPiastres: null } });
    expect(r.outfits[0]?.missing.some((m) => m.reason === "no_item_in_size")).toBe(true);
  });

  it("honours locked anchors (complete the look)", () => {
    const anchor = catalog().find((c) => c.itemId === "dress-2")!;
    const r = optimizeOutfits({ candidates: catalog(), request: { ...REQ, budgetPiastres: null, locked: [anchor] } });
    expect(r.outfits.length).toBeGreaterThan(0);
    expect(r.outfits.every((o) => o.items.some((i) => i.itemId === "dress-2"))).toBe(true);
  });

  it("returns best so far when the time budget is exhausted", () => {
    let t = 0;
    const r = optimizeOutfits({ candidates: catalog(), request: { ...REQ, budgetPiastres: null }, now: () => (t += 1000) });
    expect(r.timedOut).toBe(true);
    for (const o of r.outfits) expect(checkOutfit(o.items, { ...REQ, budgetPiastres: null })).toEqual([]);
  });

  it("matches the exhaustive oracle on small catalogs when the beam covers the space", () => {
    const small: Candidate[] = [];
    for (const slot of ["top", "bottom", "shoes", "bag", "accessory"] as const) {
      const store = slot === "top" || slot === "bottom" ? "s1" : slot === "shoes" || slot === "bag" ? "s2" : "s3";
      small.push(cand(`${slot}-a`, slot, 120, { colors: ["red"], storeId: store }));
      small.push(cand(`${slot}-b`, slot, 80, { colors: ["black"], popularity: 900, storeId: store }));
    }
    const req = { ...REQ, budgetPiastres: 45_000n };
    const r = optimizeOutfits({ candidates: small, request: req });
    expect(r.outfits.every((o) => o.complete)).toBe(true);
    const best = Math.max(...r.outfits.map((o) => o.score));
    // oracle
    const slots = ["top", "bottom", "shoes", "bag", "accessory"] as const;
    let oracle = -Infinity;
    for (let m = 0; m < 32; m++) {
      const pick = slots.map((s, i) => small.find((c) => c.itemId === `${s}-${(m >> i) & 1 ? "b" : "a"}`)!);
      if (checkOutfit(pick, req).length > 0) continue;
      const o = optimizeOutfits({ candidates: pick, request: req, config: { ...DEFAULT_OPTIMIZER_CONFIG, minOutfits: 1 } });
      oracle = Math.max(oracle, ...o.outfits.map((x) => x.score));
    }
    expect(best).toBe(oracle);
  });
});

describe("rules fallback", () => {
  it("returns source=rules, complete, within budget, without embeddings", () => {
    const withEmb = catalog().map((c) => ({ ...c, embedding: [1, 0, 0] }));
    const r = rulesOutfits({ candidates: withEmb, request: { ...REQ, budgetPiastres: 1_500_000n } });
    expect(r.source).toBe("rules");
    expect(r.outfits.length).toBeGreaterThan(0);
    for (const o of r.outfits) {
      expect(o.source).toBe("rules");
      expect(checkOutfit(o.items, { ...REQ, budgetPiastres: 1_500_000n })).toEqual([]);
    }
  });
});

describe("style vector and capsule", () => {
  it("moves toward likes, away from dislikes, stays unit length", () => {
    const v1 = updateStyleVector(null, [1, 0], "like");
    expect(v1).toEqual([1, 0]);
    const v2 = updateStyleVector(v1, [0, 1], "dislike");
    expect(v2[1]!).toBeLessThan(0);
    expect(Math.hypot(...v2)).toBeCloseTo(1, 4);
    expect(updateStyleVector([1, 0, 0], [1, 0], "like")).toEqual([1, 0, 0]);
  });
  it("capsule respects the budget and piece count", () => {
    const p = planCapsule({ candidates: catalog(), request: { ...REQ, budgetPiastres: 500_000n }, pieces: 10, maxOutfits: 20 });
    expect(p.totalPiastres <= 500_000n).toBe(true);
    expect(p.items.length).toBeLessThanOrEqual(10);
  });
});

// ---- property tests ------------------------------------------------------------------------

const candArb = (slot: Slot, idx: number): fc.Arbitrary<Candidate> =>
  fc.record({
    price: fc.integer({ min: 1, max: 3000 }),
    store: fc.constantFrom(...STORES),
    colour: fc.constantFrom(...COLORS),
    formality: fc.integer({ min: 0, max: 4 }),
    pct: fc.integer({ min: 0, max: 70 }),
    inSize: fc.boolean(),
    pop: fc.integer({ min: 0, max: 1000 }),
    sleeve: fc.constantFrom("none", "short", "elbow", "long", "n/a"),
    neckline: fc.constantFrom("low", "mid", "high", "n/a"),
    length: fc.constantFrom("mini", "knee", "midi", "maxi", "n/a"),
  }).map((r) => ({
    itemId: `${slot}-${String(idx).padStart(3, "0")}`,
    storeId: r.store,
    slot,
    pricePiastres: BigInt(r.price) * 100n,
    verifiedDiscountPct: r.pct,
    colors: [r.colour],
    formality: r.formality,
    seasons: ["all"] as const,
    coverage: { sleeve: r.sleeve, neckline: r.neckline, length: r.length } as Candidate["coverage"],
    popularity: r.pop,
    inSize: r.inSize,
  }));

const catalogArb = fc
  .tuple(...SLOTS.map((s) => fc.integer({ min: 0, max: 6 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candArb(s, i))))))
  .map((lists) => lists.flat() as Candidate[]);

const requestArb = fc.record({
  budget: fc.option(fc.integer({ min: 100, max: 12_000 }), { nil: null }),
  modest: fc.boolean(),
  scoped: fc.boolean(),
  formality: fc.integer({ min: 0, max: 4 }),
});

describe("properties", () => {
  it("never exceeds the budget, store cap, size or modest rules over 10k random catalogs", () => {
    fc.assert(
      fc.property(catalogArb, requestArb, (items, r) => {
        const req: OutfitRequest = {
          ...REQ,
          budgetPiastres: r.budget === null ? null : BigInt(r.budget) * 100n,
          modest: r.modest,
          scopedToSingleStore: r.scoped,
          occasionFormality: r.formality,
        };
        let t = 0;
        for (const run of [
          optimizeOutfits({ candidates: items, request: req, now: () => t++ }),
          rulesOutfits({ candidates: items, request: req }),
        ]) {
          for (const o of run.outfits) {
            if (req.budgetPiastres !== null && o.totalPiastres > req.budgetPiastres) return false;
            if (checkOutfit(o.items, req).length > 0) return false;
            if (o.complete && o.missing.length > 0) return false;
          }
        }
        return true;
      }),
      { numRuns: 10_000 },
    );
  }, 120_000);

  it("never returns an item that is not in the supplied catalog and never invents prices", () => {
    fc.assert(
      fc.property(catalogArb, (items) => {
        const byId = new Map(items.map((i) => [i.itemId, i.pricePiastres]));
        const r = optimizeOutfits({ candidates: items, request: { ...REQ, budgetPiastres: null } });
        return r.outfits.every((o) => o.items.every((i) => byId.get(i.itemId) === i.pricePiastres));
      }),
      { numRuns: 300 },
    );
  });

  it("capsule never exceeds budget or piece count", () => {
    fc.assert(
      fc.property(catalogArb, fc.integer({ min: 100, max: 8000 }), (items, b) => {
        const p = planCapsule({ candidates: items, request: { ...REQ, budgetPiastres: BigInt(b) * 100n }, pieces: 10, maxOutfits: 20 });
        return p.totalPiastres <= BigInt(b) * 100n && p.items.length <= 10;
      }),
      { numRuns: 300 },
    );
  });
});
