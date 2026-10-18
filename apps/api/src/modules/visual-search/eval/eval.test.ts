import { describe, expect, it } from "vitest";
import { FAKE_MODEL_VERSION, InMemoryVisualIndex } from "../adapters/in-memory";
import { meetsThresholds, recallAtK, reciprocalRank } from "../domain/metrics";
import { evaluateRetrieval } from "./harness";
import { buildSyntheticSet, DEFAULT_SYNTHETIC } from "./synthetic";
import { SYNTHETIC_K, SYNTHETIC_THRESHOLDS } from "./thresholds";

const indexOf = (set: ReturnType<typeof buildSyntheticSet>, version = FAKE_MODEL_VERSION) => {
  const idx = new InMemoryVisualIndex();
  for (const p of set.products) idx.set(p.productId, p.vector, version);
  return idx;
};

describe("metrics", () => {
  it("recall@k, MRR on hand-computed cases", () => {
    const rel = new Set(["a", "b"]);
    expect(recallAtK(["x", "a", "y", "b"], rel, 2)).toBe(0.5);
    expect(recallAtK(["x", "a", "y", "b"], rel, 4)).toBe(1);
    expect(reciprocalRank(["x", "y", "a"], rel)).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["x", "y"], rel)).toBe(0);
    expect(() => recallAtK([], new Set(), 3)).toThrow();
  });
});

describe("synthetic retrieval evaluation (regression gate)", () => {
  const set = buildSyntheticSet();

  it("is deterministic", () => {
    const again = buildSyntheticSet();
    expect(again.queries[7]?.vector.slice(0, 8)).toEqual(set.queries[7]?.vector.slice(0, 8));
    expect(set.products).toHaveLength(DEFAULT_SYNTHETIC.groups * DEFAULT_SYNTHETIC.perGroup);
    expect(set.queries).toHaveLength(DEFAULT_SYNTHETIC.groups * DEFAULT_SYNTHETIC.queriesPerGroup);
  });

  it("meets the CI thresholds with the brute-force index", async () => {
    const report = await evaluateRetrieval({ index: indexOf(set), modelVersion: FAKE_MODEL_VERSION, queries: set.queries, k: SYNTHETIC_K });
    console.log(`synthetic eval: queries=${report.queries} recall@${report.k}=${report.recallAtK.toFixed(4)} mrr=${report.mrr.toFixed(4)} coverage=${report.coverage}`);
    expect(meetsThresholds(report, SYNTHETIC_THRESHOLDS)).toBe(true);
    expect(Object.keys(report.byCategory).sort()).toEqual(["bag", "dress", "shoes", "top"]);
  });

  it("the gate is sensitive: a noisy embedder, a wrong model version and missing embeddings all fail it", async () => {
    const noisy = buildSyntheticSet({ ...DEFAULT_SYNTHETIC, queryNoise: 6 });
    const r1 = await evaluateRetrieval({ index: indexOf(noisy), modelVersion: FAKE_MODEL_VERSION, queries: noisy.queries, k: SYNTHETIC_K });
    expect(meetsThresholds(r1, SYNTHETIC_THRESHOLDS)).toBe(false);

    const r2 = await evaluateRetrieval({ index: indexOf(set, "old-model"), modelVersion: FAKE_MODEL_VERSION, queries: set.queries, k: SYNTHETIC_K });
    expect(r2.recallAtK).toBe(0);
    expect(r2.coverage).toBe(0);
    expect(meetsThresholds(r2, SYNTHETIC_THRESHOLDS)).toBe(false);

    const half = new InMemoryVisualIndex();
    for (const p of set.products.slice(0, set.products.length / 2)) half.set(p.productId, p.vector);
    const r3 = await evaluateRetrieval({ index: half, modelVersion: FAKE_MODEL_VERSION, queries: set.queries, k: SYNTHETIC_K });
    expect(r3.coverage).toBeLessThan(1);
    expect(meetsThresholds(r3, SYNTHETIC_THRESHOLDS)).toBe(false);
  });

  it("an empty query set never passes", async () => {
    const r = await evaluateRetrieval({ index: indexOf(set), modelVersion: FAKE_MODEL_VERSION, queries: [], k: 5 });
    expect(meetsThresholds(r, SYNTHETIC_THRESHOLDS)).toBe(false);
  });
});
