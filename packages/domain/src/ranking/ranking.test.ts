import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../recommendations/ranking";
import type { Candidate } from "../recommendations/types";
import {
  BOT_SCORE_THRESHOLD_PERMILLE,
  DEFAULT_GUARDRAIL_CONFIG,
  DEFAULT_REGRESSION_GATE,
  FakeRanker,
  LinearRanker,
  RANKING_FEATURE_NAMES,
  TreeEnsembleRanker,
  averagePrecision,
  buildFeatureVector,
  checkRegression,
  compareShadow,
  evaluateGuardrails,
  evaluateRanker,
  generateSyntheticLogs,
  hitRateAtK,
  ipsWeight,
  ndcgAtK,
  positionPropensity,
  rankV2,
  scoreNextItems,
  trainTransitions,
  vectorViolations,
  type SessionEvent,
} from "./index";

const NOW = 1_800_000_000_000;
const cand = (id: string, store: string, o: Partial<Candidate> = {}): Candidate => ({
  productId: id,
  storeId: store,
  categoryId: "dresses",
  popularity: 100,
  createdAtMs: NOW - 86_400_000,
  priceMinor: 100_000n,
  claimAllowed: true,
  verifiedDiscountPct: 20,
  sellerHealth: 80,
  priceTrust: 80,
  returnRatePermille: 50,
  storeActive: true,
  inStock: true,
  sizesInStock: [],
  isNewSeller: false,
  ...o,
});
const USER = { categoryAffinity: { dresses: 900 }, storeAffinity: { s1: 500 }, builtAtMs: NOW };

describe("feature vector", () => {
  it("has no forbidden budget-like name", () => {
    expect(vectorViolations({ values: Object.fromEntries(RANKING_FEATURE_NAMES.map((n) => [n, 1])) })).toEqual([]);
  });
  it("flags unknown and budget keys", () => {
    expect(vectorViolations({ values: { remaining_budget: 5 } }).length).toBeGreaterThan(0);
    expect(vectorViolations({ values: { surprise: 5 } })).toEqual(["values.surprise"]);
  });
  it("personalization off yields zero user features and ignores the user object", () => {
    const v = buildFeatureVector(cand("a", "s1"), USER, false, NOW);
    expect(v.personalized).toBe(false);
    expect(v.values.category_affinity).toBe(0);
    expect(v.values.store_affinity).toBe(0);
    expect(buildFeatureVector(cand("a", "s1"), USER, true, NOW).values.category_affinity).toBe(900);
  });
  it("hides discount when the claim is not allowed", () => {
    expect(buildFeatureVector(cand("a", "s1", { claimAllowed: false }), null, false, NOW).values.verified_discount_pct).toBe(0);
  });
});

describe("models", () => {
  it("fake ranker is deterministic and seed dependent", () => {
    const v = [buildFeatureVector(cand("a", "s"), null, false, NOW)];
    expect(new FakeRanker().score(v)).toEqual(new FakeRanker().score(v));
    expect(new FakeRanker("m", "x").score(v)).not.toEqual(new FakeRanker("m", "y").score(v));
  });
  it("tree ensemble sums trees", () => {
    const m = new TreeEnsembleRanker("t", [
      { feature: "popularity", threshold: 50, left: { leaf: 1 }, right: { leaf: 5 } },
      { leaf: 10 },
    ]);
    expect(m.score([buildFeatureVector(cand("a", "s"), null, false, NOW)])).toEqual([15]);
  });
  it("linear ranker prefers higher discount", () => {
    const m = new LinearRanker();
    const [lo, hi] = m.score([
      buildFeatureVector(cand("a", "s", { verifiedDiscountPct: 5 }), null, false, NOW),
      buildFeatureVector(cand("b", "s", { verifiedDiscountPct: 50 }), null, false, NOW),
    ]);
    expect(hi).toBeGreaterThan(lo ?? 0);
  });
});

describe("rankV2", () => {
  const pool = Array.from({ length: 40 }, (_, i) => cand(`p${i}`, i < 30 ? "s1" : `s${i}`, { popularity: 1000 - i }));
  const newPool = Array.from({ length: 10 }, (_, i) => cand(`n${i}`, `ns${i}`, { isNewSeller: true }));
  const base = { candidates: pool, user: USER, personalized: true, nowMs: NOW, limit: 40, model: new LinearRanker(), newSellerPool: newPool, explorationStats: new Map() };

  it("never has more than 2 consecutive items of one store while others remain", () => {
    const r = rankV2({ ...base, rng: seededRng(1) });
    let run = 0;
    let prev = "";
    r.items.slice(0, 20).forEach((x) => {
      run = x.candidate.storeId === prev ? run + 1 : 1;
      prev = x.candidate.storeId;
      expect(run).toBeLessThanOrEqual(2);
    });
  });
  it("exploration is capped at 5% of the list", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1, max: 1_000_000 }), (limit, seed) => {
        const r = rankV2({ ...base, limit, rng: seededRng(seed) });
        expect(r.explorationCount).toBeLessThanOrEqual(Math.floor(limit * 0.05));
        expect(r.items.length).toBeLessThanOrEqual(limit);
      }),
    );
  });
  it("same seed gives the same list, different request seed may differ", () => {
    const a = rankV2({ ...base, limit: 100, rng: seededRng(7) }).items.map((x) => x.candidate.productId);
    const b = rankV2({ ...base, limit: 100, rng: seededRng(7) }).items.map((x) => x.candidate.productId);
    expect(a).toEqual(b);
  });
  it("bot requests get no exploration and are not trainable", () => {
    const r = rankV2({ ...base, limit: 100, rng: seededRng(1), botScorePermille: BOT_SCORE_THRESHOLD_PERMILLE });
    expect(r.explorationCount).toBe(0);
    expect(r.botFiltered).toBe(true);
    expect(r.trainable).toBe(false);
  });
  it("non-personalized run produces vectors with no user signal", () => {
    const r = rankV2({ ...base, personalized: false, rng: seededRng(1) });
    expect(r.vectors.every((v) => !v.personalized && v.values.category_affinity === 0)).toBe(true);
  });
});

describe("offline evaluation", () => {
  it("ndcg and map known values", () => {
    expect(ndcgAtK([3, 2, 1, 0], 4)).toBeCloseTo(1, 10);
    expect(ndcgAtK([0, 0, 0, 3], 4)).toBeLessThan(0.5);
    expect(ndcgAtK([0, 0], 2)).toBe(0);
    expect(averagePrecision([1, 0, 1])).toBeCloseTo((1 + 2 / 3) / 2, 10);
    expect(averagePrecision([0, 0])).toBe(0);
  });
  it("propensity decreases and ips weight is clamped", () => {
    expect(positionPropensity(1)).toBe(1);
    expect(positionPropensity(5)).toBeLessThan(positionPropensity(2));
    expect(ipsWeight(1000)).toBe(10);
  });
  const logs = generateSyntheticLogs({ seed: seededRng(42), requests: 200 });
  it("synthetic logs are reproducible", () => {
    expect(generateSyntheticLogs({ seed: seededRng(42), requests: 5 })).toEqual(generateSyntheticLogs({ seed: seededRng(42), requests: 5 }));
  });
  it("linear v2 beats fake and passes the regression gate against the popularity baseline", () => {
    const linear = evaluateRanker(new LinearRanker(), logs, 10);
    const pop = evaluateRanker(new LinearRanker("pop", { popularity: 1 }), logs, 10);
    const fake = evaluateRanker(new FakeRanker(), logs, 10);
    expect(linear.ndcgAtK).toBeGreaterThan(fake.ndcgAtK);
    expect(linear.ndcgAtK).toBeGreaterThan(pop.ndcgAtK);
    expect(checkRegression(linear, pop, DEFAULT_REGRESSION_GATE).passed).toBe(true);
  });
  it("the gate rejects a regression and too little data", () => {
    const linear = evaluateRanker(new LinearRanker(), logs, 10);
    const fake = evaluateRanker(new FakeRanker(), logs, 10);
    expect(checkRegression(fake, linear).reasons).toContain("ndcg_regression_vs_baseline");
    expect(checkRegression({ ...linear, requests: 3 }, linear).reasons).toContain("insufficient_requests");
  });
  it("bot impressions are excluded from evaluation", () => {
    const bots = logs.filter((l) => l.botScorePermille >= BOT_SCORE_THRESHOLD_PERMILLE).length;
    expect(bots).toBeGreaterThan(0);
    const m = evaluateRanker(new LinearRanker(), logs, 10);
    expect(m.requests).toBeLessThan(200);
  });
});

describe("session model", () => {
  const ev = (ids: string[]): SessionEvent[] => ids.map((productId, i) => ({ productId, kind: "view", atMs: i * 1000 }));
  const train = Array.from({ length: 20 }, () => ev(["a", "b", "c"]));
  const model = trainTransitions(train);
  it("predicts the learned successor and not already seen items", () => {
    const s = scoreNextItems(model, ev(["a"]), ["b", "c", "z"]);
    expect((s.get("b") ?? 0)).toBeGreaterThan(s.get("c") ?? 0);
    expect(s.get("z")).toBe(0);
    expect(scoreNextItems(model, ev(["a", "b"]), ["a", "b", "c"]).get("a")).toBe(0);
  });
  it("hit rate on held-out next item", () => {
    expect(hitRateAtK(model, train, ["a", "b", "c", "d"], 1)).toBe(1);
  });
});

describe("guardrails and shadow", () => {
  const c = DEFAULT_GUARDRAIL_CONFIG;
  it("needs enough orders", () => {
    expect(evaluateGuardrails(c, { orders: 10, returned: 1, complaints: 0 }, { orders: 10, returned: 1, complaints: 0 }).decision).toBe("insufficient_data");
  });
  it("halts on return rate and complaint increases, continues otherwise", () => {
    const ctl = { orders: 1000, returned: 100, complaints: 10 };
    expect(evaluateGuardrails(c, ctl, { orders: 1000, returned: 130, complaints: 10 }).breaches).toEqual(["return_rate"]);
    expect(evaluateGuardrails(c, ctl, { orders: 1000, returned: 100, complaints: 15 }).breaches).toEqual(["complaint_rate"]);
    expect(evaluateGuardrails(c, ctl, { orders: 1000, returned: 105, complaints: 11 }).decision).toBe("continue");
  });
  it("shadow comparison", () => {
    const r = compareShadow(["a", "b", "c"], new Map([["a", 3], ["c", 2], ["b", 1]]), 2);
    expect(r.top1Same).toBe(true);
    expect(r.overlapPermille).toBe(500);
    expect(compareShadow([], new Map()).overlapPermille).toBe(1000);
  });
});
