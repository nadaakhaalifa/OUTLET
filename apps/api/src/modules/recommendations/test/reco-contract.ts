import { describe, expect, it } from "vitest";
import type { RecoStore } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const NOW = 1_800_000_000_000;

export interface RecoContractCtx {
  readonly store: RecoStore;
  outboxTypes(): Promise<string[]>;
  setActiveModel(v: string | null): Promise<void>;
}

export function describeRecoStoreContract(name: string, make: () => Promise<RecoContractCtx>): void {
  describe(`RecoStore contract: ${name}`, () => {
    it("co-occurrence: upsert replaces, neighbors ordered by score then id, self pairs ignored", async () => {
      const c = await make();
      const n = await c.store.upsertCooccurrence(
        [
          { itemA: U(1), itemB: U(2), kind: "co_buy", score: 5, windowDays: 90 },
          { itemA: U(1), itemB: U(3), kind: "co_buy", score: 9, windowDays: 90 },
          { itemA: U(1), itemB: U(4), kind: "co_buy", score: 5, windowDays: 90 },
          { itemA: U(1), itemB: U(1), kind: "co_buy", score: 5, windowDays: 90 },
          { itemA: U(1), itemB: U(5), kind: "co_view", score: 2, windowDays: 30 },
        ],
        NOW,
      );
      expect(n).toBe(4);
      expect((await c.store.neighbors(U(1), "co_buy", 10)).map((x) => x.productId)).toEqual([U(3), U(2), U(4)]);
      await c.store.upsertCooccurrence([{ itemA: U(1), itemB: U(2), kind: "co_buy", score: 20, windowDays: 90 }], NOW);
      expect((await c.store.neighbors(U(1), "co_buy", 1))[0]).toEqual({ productId: U(2), score: 20 });
      expect((await c.store.neighbors(U(1), "co_view", 10)).map((x) => x.productId)).toEqual([U(5)]);
    });

    it("model registry: no active model, then the active version", async () => {
      const c = await make();
      await c.setActiveModel(null);
      expect(await c.store.activeModelVersion()).toBeNull();
      await c.setActiveModel("ltr-v7");
      expect(await c.store.activeModelVersion()).toBe("ltr-v7");
    });

    it("impressions and clicks are counted with an outbox event each; exploration stats read back", async () => {
      const c = await make();
      await c.store.recordImpressions(
        "exploration",
        [U(10), U(11)],
        { type: "recommendation.impression", module: "exploration", modelVersion: "v", productIds: [U(10), U(11)], personalized: false },
        NOW,
      );
      await c.store.recordImpressions(
        "exploration",
        [U(10)],
        { type: "recommendation.impression", module: "exploration", modelVersion: "v", productIds: [U(10)], personalized: true },
        NOW,
      );
      await c.store.recordClick(
        "exploration",
        U(10),
        { type: "recommendation.click", module: "exploration", modelVersion: "v", productId: U(10) },
        NOW,
      );
      const s = await c.store.explorationStats([U(10), U(11), U(12)]);
      expect(s.get(U(10))).toEqual({ impressions: 2, clicks: 1 });
      expect(s.get(U(11))).toEqual({ impressions: 1, clicks: 0 });
      expect(s.has(U(12))).toBe(false);
      expect(await c.outboxTypes()).toEqual(["recommendation.impression", "recommendation.impression", "recommendation.click"]);
    });

    it("a click on an item never counted as shown keeps clicks <= impressions", async () => {
      const c = await make();
      await c.store.recordClick(
        "exploration",
        U(20),
        { type: "recommendation.click", module: "exploration", modelVersion: "v", productId: U(20) },
        NOW,
      );
      expect((await c.store.explorationStats([U(20)])).get(U(20))).toEqual({ impressions: 1, clicks: 1 });
    });
  });
}
