import { describe, expect, it } from "vitest";
import type { EvalRunStore, ShadowLogStore, EvalRunRecord, ShadowRunRecord } from "../domain/ports";
import { FEATURES_FIXTURE } from "./fixtures";

export interface Stores {
  readonly shadow: ShadowLogStore;
  readonly evals: EvalRunStore;
}
const T0 = 1_800_000_000_000;
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const p = (n: number): string => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, "0")}`;
const run = (n: number, o: Partial<ShadowRunRecord> = {}): ShadowRunRecord => ({
  id: id(n),
  module: "feed",
  servedModelVersion: "ltr-v1",
  shadowModelVersion: "linear-baseline-v2",
  personalized: false,
  botFiltered: false,
  candidateCount: 10,
  k: 10,
  overlapPermille: 800,
  top1Same: true,
  meanRankShiftMilli: 1500,
  createdAtMs: T0 + n * 1000,
  ...o,
});
const evalRun = (n: number, key: string, o: Partial<EvalRunRecord> = {}): EvalRunRecord => ({
  id: id(100 + n),
  requestKey: key,
  candidateVersion: "linear-baseline-v2",
  baselineVersion: "popularity-baseline",
  dataset: "synthetic",
  seed: 7,
  requests: 120,
  k: 10,
  candidateNdcgBps: 8200,
  candidateMapBps: 7100,
  baselineNdcgBps: 7000,
  baselineMapBps: 6500,
  passed: true,
  reasons: [],
  createdAtMs: T0 + n * 1000,
  ...o,
});

export function describeRankingStoreContract(name: string, make: () => Promise<Stores>): void {
  describe(`ranking stores: ${name}`, () => {
    it("records a shadow run with items and reads them back in v2 order", async () => {
      const { shadow } = await make();
      await shadow.record(run(1), [
        { productId: p(2), v1Rank: 5, v2Rank: 2, v2ScoreMilli: 1_500n, features: FEATURES_FIXTURE },
        { productId: p(1), v1Rank: 1, v2Rank: 1, v2ScoreMilli: 9_000_000n, features: FEATURES_FIXTURE },
      ]);
      const items = await shadow.itemsOf(id(1));
      expect(items.map((i) => i.productId)).toEqual([p(1), p(2)]);
      expect(items[0]?.v2ScoreMilli).toBe(9_000_000n);
      expect(items[0]?.features.popularity).toBe(FEATURES_FIXTURE.popularity);
    });

    it("summarises a window", async () => {
      const { shadow } = await make();
      await shadow.record(run(1), []);
      await shadow.record(run(2, { personalized: true, overlapPermille: 600, top1Same: false, botFiltered: true }), []);
      await shadow.record(run(3, { createdAtMs: T0 - 10 * 86_400_000 }), []);
      const s = await shadow.summary(T0);
      expect(s.runs).toBe(2);
      expect(s.personalizedRuns).toBe(1);
      expect(s.botFilteredRuns).toBe(1);
      expect(s.meanOverlapPermille).toBe(700);
      expect(s.top1SamePermille).toBe(500);
      expect(s.shadowModelVersions).toEqual(["linear-baseline-v2"]);
    });

    it("empty window has null means", async () => {
      const { shadow } = await make();
      const s = await shadow.summary(T0);
      expect(s).toMatchObject({ runs: 0, meanOverlapPermille: null, top1SamePermille: null });
    });

    it("purge removes old runs and their items", async () => {
      const { shadow } = await make();
      await shadow.record(run(1, { createdAtMs: T0 - 40 * 86_400_000 }), [{ productId: p(1), v1Rank: 1, v2Rank: 1, v2ScoreMilli: 1n, features: FEATURES_FIXTURE }]);
      await shadow.record(run(2), []);
      expect(await shadow.purgeBefore(T0 - 30 * 86_400_000)).toBe(1);
      expect(await shadow.itemsOf(id(1))).toEqual([]);
      expect((await shadow.summary(0)).runs).toBe(1);
    });

    it("evaluation insert is idempotent by request key and listing is newest first", async () => {
      const { evals } = await make();
      const a = await evals.insert(evalRun(1, "key-aaaaaaaa"));
      expect(a.created).toBe(true);
      const dup = await evals.insert(evalRun(2, "key-aaaaaaaa", { passed: false }));
      expect(dup.created).toBe(false);
      expect(dup.run.id).toBe(a.run.id);
      expect(dup.run.passed).toBe(true);
      await evals.insert(evalRun(3, "key-bbbbbbbb", { reasons: ["below_ndcg_floor"], passed: false }));
      const l = await evals.list(10);
      expect(l.map((r) => r.requestKey)).toEqual(["key-bbbbbbbb", "key-aaaaaaaa"]);
      expect(l[0]?.reasons).toEqual(["below_ndcg_floor"]);
      expect(l[0]?.createdAtMs).toBe(T0 + 3000);
    });
  });
}
