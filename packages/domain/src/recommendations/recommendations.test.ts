import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLEAR_DEADLINE_MS,
  EXPLORATION_CAP_PERCENT,
  buildFeatures,
  clearDeadline,
  cosine,
  diversify,
  forbiddenFeatureKeys,
  isClearOverdue,
  isSimilarForLess,
  isVisible,
  maxExplorationSlots,
  mergeExploration,
  normalizeDetail,
  personalizationDecision,
  pickExploration,
  priceDrops,
  recordDecision,
  restockDue,
  retentionCutoffMs,
  sampleBeta,
  seededRng,
  upsertRecentlyViewed,
  type Candidate,
  type HistoryEvent,
  type ScoredCandidate,
} from "./index";

const NOW = 1_800_000_000_000;
const cand = (id: string, store: string, over: Partial<Candidate> = {}): Candidate => ({
  productId: id,
  storeId: store,
  categoryId: "dress",
  popularity: 10,
  createdAtMs: NOW - 86_400_000,
  priceMinor: 100_000n,
  claimAllowed: false,
  verifiedDiscountPct: 0,
  sellerHealth: 80,
  priceTrust: 80,
  returnRatePermille: 50,
  storeActive: true,
  inStock: true,
  sizesInStock: [],
  isNewSeller: false,
  ...over,
});
const sc = (c: Candidate, score = 0): ScoredCandidate => ({ candidate: c, score, exploration: false });

describe("history rules", () => {
  it("paused drops, active records", () => {
    expect(recordDecision(true)).toBe("drop_paused");
    expect(recordDecision(false)).toBe("record");
  });
  it("clear deadline is 24h and overdue only while incomplete", () => {
    expect(clearDeadline(NOW)).toBe(NOW + CLEAR_DEADLINE_MS);
    expect(isClearOverdue(NOW, null, NOW + 1)).toBe(true);
    expect(isClearOverdue(NOW, NOW - 5, NOW + 1)).toBe(false);
    expect(isClearOverdue(NOW + 10, null, NOW)).toBe(false);
  });
  it("retention cutoff is 25 calendar months back", () => {
    expect(new Date(retentionCutoffMs(Date.UTC(2026, 9, 11))).toISOString().slice(0, 7)).toBe("2024-09");
  });
  it("normalizes detail", () => {
    expect(normalizeDetail("  a\u0000  b ")).toBe("a b");
    expect(normalizeDetail("   ")).toBeNull();
    expect(normalizeDetail("x".repeat(500))?.length).toBe(120);
  });
  it("recently viewed: unique, newest first, capped", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.integer({ min: 0, max: 8 }), t: fc.integer({ min: 0, max: 1000 }) }), { maxLength: 40 }),
        fc.integer({ min: 1, max: 6 }),
        (views, cap) => {
          let list: readonly { productId: string; viewedAtMs: number; priceMinor: bigint | null }[] = [];
          for (const v of views) list = upsertRecentlyViewed(list, { productId: `p${v.id}`, viewedAtMs: v.t, priceMinor: null }, cap);
          expect(list.length).toBeLessThanOrEqual(cap);
          expect(new Set(list.map((x) => x.productId)).size).toBe(list.length);
          for (let i = 1; i < list.length; i++) expect(list[i - 1]!.viewedAtMs).toBeGreaterThanOrEqual(list[i]!.viewedAtMs);
        },
      ),
    );
  });
});

describe("features", () => {
  const ev = (type: HistoryEvent["type"], cat: string, store: string, ageDays: number): HistoryEvent => ({
    id: "e",
    userId: "u",
    type,
    itemId: "p",
    storeId: store,
    categoryId: cat,
    priceMinor: null,
    detail: null,
    atMs: NOW - ageDays * 86_400_000,
  });
  it("affinity is permille, bought outweighs viewed, and recent outweighs old", () => {
    const f = buildFeatures([ev("bought", "shoes", "s1", 1), ev("viewed", "bags", "s2", 1), ev("viewed", "hats", "s2", 120)], NOW);
    expect(f.categoryAffinity["shoes"]).toBe(1000);
    expect(f.categoryAffinity["bags"]!).toBeLessThan(f.categoryAffinity["shoes"]!);
    expect(f.categoryAffinity["hats"] ?? 0).toBeLessThan(f.categoryAffinity["bags"]!);
  });
  it("is order independent and bounded", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc.constantFrom("viewed", "saved", "bought", "returned", "searched", "outfit_generated" as const),
            c: fc.constantFrom("a", "b", "c"),
            s: fc.constantFrom("x", "y"),
            d: fc.integer({ min: 0, max: 400 }),
          }),
          { maxLength: 30 },
        ),
        (rows) => {
          const events = rows.map((r) => ev(r.t as HistoryEvent["type"], r.c, r.s, r.d));
          const a = buildFeatures(events, NOW);
          const b = buildFeatures([...events].reverse(), NOW);
          expect(a.categoryAffinity).toEqual(b.categoryAffinity);
          for (const v of [...Object.values(a.categoryAffinity), ...Object.values(a.storeAffinity)]) {
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThanOrEqual(1000);
          }
          expect(forbiddenFeatureKeys(a)).toEqual([]);
        },
      ),
    );
  });
  it("flags budget and measurement keys anywhere in a feature object", () => {
    expect(forbiddenFeatureKeys({ a: 1, nested: { remaining_budget: 5 } })).toEqual(["nested.remaining_budget"]);
    expect(forbiddenFeatureKeys({ waistCm: 70, afford_now: true, ok: 1 }).sort()).toEqual(["afford_now", "waistCm"]);
  });
  it("personalization decision fails closed", () => {
    const base = {
      requested: undefined,
      settingOn: true,
      consentGranted: true,
      mlRankingAllowed: true,
      features: { categoryAffinity: {}, storeAffinity: {}, builtAtMs: NOW - 1000 },
      nowMs: NOW,
    } as const;
    expect(personalizationDecision(base)).toEqual({ personalized: true, reason: "on" });
    expect(personalizationDecision({ ...base, requested: false }).reason).toBe("requested_off");
    expect(personalizationDecision({ ...base, settingOn: false }).reason).toBe("setting_off");
    expect(personalizationDecision({ ...base, consentGranted: false }).reason).toBe("no_consent");
    expect(personalizationDecision({ ...base, mlRankingAllowed: false }).reason).toBe("kill_switch");
    expect(personalizationDecision({ ...base, features: null }).reason).toBe("no_features");
    expect(
      personalizationDecision({ ...base, features: { categoryAffinity: {}, storeAffinity: {}, builtAtMs: NOW - 25 * 3_600_000 } }).reason,
    ).toBe("features_stale");
  });
});

describe("diversity re-rank", () => {
  it("is a permutation and a run above 2 happens only when forced", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 40 }), (stores) => {
        const items = stores.map((s, i) => sc(cand(`p${String(i).padStart(3, "0")}`, `s${s}`), 1000 - i));
        const out = diversify(items);
        expect(out.map((x) => x.candidate.productId).sort()).toEqual(items.map((x) => x.candidate.productId).sort());
        let run = 0;
        for (let i = 0; i < out.length; i++) {
          run = i > 0 && out[i]!.candidate.storeId === out[i - 1]!.candidate.storeId ? run + 1 : 1;
          if (run > 2) {
            const store = out[i]!.candidate.storeId;
            expect(out.slice(i).every((x) => x.candidate.storeId === store)).toBe(true);
          }
        }
      }),
    );
  });
  it("separates a store that dominates the top", () => {
    const items = [1, 2, 3, 4].map((n) => sc(cand(`a${n}`, "A"), 100 - n)).concat([sc(cand("b1", "B"), 1)]);
    const out = diversify(items).map((x) => x.candidate.productId);
    expect(out).toEqual(["a1", "a2", "b1", "a3", "a4"]);
  });
});

describe("exploration", () => {
  it("caps slots at 5 percent", () => {
    expect(EXPLORATION_CAP_PERCENT).toBe(5);
    expect(maxExplorationSlots(19)).toBe(0);
    expect(maxExplorationSlots(20)).toBe(1);
    expect(maxExplorationSlots(100)).toBe(5);
  });
  it("never exceeds the cap for any pool, stats or seed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 60 }), fc.integer(), (n, poolSize, seed) => {
        const pool = Array.from({ length: poolSize }, (_, i) => cand(`n${i}`, `st${i}`, { isNewSeller: true }));
        const picked = pickExploration(pool, new Map(), n, seededRng(seed));
        expect(picked.length).toBeLessThanOrEqual(Math.floor(n * 0.05));
        const merged = mergeExploration(
          Array.from({ length: n }, (_, i) => sc(cand(`r${i}`, `s${i % 5}`))),
          picked,
        );
        expect(merged.filter((m) => m.exploration).length).toBeLessThanOrEqual(Math.floor(n * 0.05));
        expect(merged.length).toBe(n + picked.length);
      }),
    );
  });
  it("is deterministic for a seed, and a high-CTR arm wins most draws", () => {
    const pool = [cand("good", "g", { isNewSeller: true }), cand("bad", "b", { isNewSeller: true })];
    const stats = new Map([
      ["good", { impressions: 200, clicks: 80 }],
      ["bad", { impressions: 200, clicks: 2 }],
    ]);
    const a = pickExploration(pool, stats, 20, seededRng(7)).map((c) => c.productId);
    const b = pickExploration(pool, stats, 20, seededRng(7)).map((c) => c.productId);
    expect(a).toEqual(b);
    let good = 0;
    const rng = seededRng(99);
    for (let i = 0; i < 100; i++) if (pickExploration(pool, stats, 20, rng)[0]?.productId === "good") good++;
    expect(good).toBeGreaterThan(95);
  });
  it("beta samples stay in (0,1)", () => {
    const rng = seededRng(1);
    for (let i = 0; i < 200; i++) {
      const x = sampleBeta(1 + (i % 7), 1 + (i % 11), rng);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
    }
  });
  it("skips suspended or out-of-stock new sellers", () => {
    const pool = [cand("x", "s", { isNewSeller: true, storeActive: false }), cand("y", "t", { isNewSeller: true, inStock: false })];
    expect(pickExploration(pool, new Map(), 100, seededRng(1))).toEqual([]);
  });
});

describe("similar and restock", () => {
  it("cosine basics and properties", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow(RangeError);
    fc.assert(
      fc.property(fc.array(fc.double({ min: -5, max: 5, noNaN: true }), { minLength: 3, maxLength: 3 }), (v) => {
        const s = cosine(v, v);
        expect(s === 0 || Math.abs(s - 1) < 1e-9).toBe(true);
      }),
    );
  });
  it("similar-for-less needs strictly lower price and a verified claim", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000n }), fc.bigInt({ min: 1n, max: 10_000_000n }), fc.boolean(), (anchor, p, claim) => {
        const ok = isSimilarForLess(anchor, cand("x", "s", { priceMinor: p, claimAllowed: claim }));
        expect(ok).toBe(p < anchor && claim);
      }),
    );
  });
  it("visibility filters suspended stores, stock and user size", () => {
    expect(isVisible(cand("a", "s", { storeActive: false }), null)).toBe(false);
    expect(isVisible(cand("a", "s", { inStock: false }), null)).toBe(false);
    expect(isVisible(cand("a", "s", { sizesInStock: ["S"] }), ["M"])).toBe(false);
    expect(isVisible(cand("a", "s", { sizesInStock: ["S", "M"] }), ["M"])).toBe(true);
    expect(isVisible(cand("a", "s", { sizesInStock: ["S"] }), null)).toBe(true);
  });
  it("restock reminders only for kept basics past their interval", () => {
    const basics = new Map([["socks", 60]]);
    const day = 86_400_000;
    expect(restockDue([{ productId: "socks", boughtAtMs: NOW - 61 * day, returned: false }], basics, NOW)).toEqual(["socks"]);
    expect(restockDue([{ productId: "socks", boughtAtMs: NOW - 10 * day, returned: false }], basics, NOW)).toEqual([]);
    expect(restockDue([{ productId: "socks", boughtAtMs: NOW - 90 * day, returned: true }], basics, NOW)).toEqual([]);
    expect(restockDue([{ productId: "dress", boughtAtMs: NOW - 90 * day, returned: false }], basics, NOW)).toEqual([]);
    // a newer purchase resets the clock
    expect(
      restockDue(
        [
          { productId: "socks", boughtAtMs: NOW - 90 * day, returned: false },
          { productId: "socks", boughtAtMs: NOW - 5 * day, returned: false },
        ],
        basics,
        NOW,
      ),
    ).toEqual([]);
  });
  it("price drops are integer, only strictly lower, and never when unknown", () => {
    const out = priceDrops(
      [
        { productId: "a", priceMinor: 100_000n },
        { productId: "b", priceMinor: 100_000n },
        { productId: "c", priceMinor: null },
        { productId: "d", priceMinor: 100_000n },
      ],
      new Map([
        ["a", 80_000n],
        ["b", 100_000n],
        ["c", 1n],
      ]),
    );
    expect(out).toEqual([{ productId: "a", seenMinor: 100_000n, nowMinor: 80_000n, dropMinor: 20_000n, dropPct: 20 }]);
  });
});
