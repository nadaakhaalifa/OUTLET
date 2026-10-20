import { describe, expect, it } from "vitest";
import type { StylistStore } from "../domain/ports";
import { START_MS, STORES, U, record, sku } from "./fixtures";

export interface StoreFixture {
  readonly store: StylistStore;
  readonly ensureUser: (id: string) => Promise<void>;
  readonly eventTypes: () => Promise<readonly string[]>;
}

export function describeStylistStoreContract(name: string, make: () => Promise<StoreFixture>): void {
  describe(`stylist store contract: ${name}`, () => {
    it("round-trips an outfit including missing slots and bigint money", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const r = record(1, U(1), {
        complete: false,
        missing: [{ slot: "bag", reason: "budget", addPiastres: 12_345n }],
        totalPiastres: 9_007_199_254_740_993n,
        budgetPiastres: null,
        items: [{ itemId: sku(1), storeId: U(9001), slot: "top", pricePiastres: 9_007_199_254_740_993n, verifiedDiscountPct: 0 }],
      });
      await f.store.insertOutfits([r], []);
      const got = await f.store.getOutfit(r.id);
      expect(got).toEqual(r);
      expect(await f.store.getOutfit(U(999))).toBeNull();
    });

    it("aggregates inclusion per store with distinct shoppers inside the window only", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      const a = record(1, U(1));
      const b = record(2, U(1));
      const c = record(3, U(2));
      await f.store.insertOutfits([a, b, c], []);
      await f.store.markAddedToBag(a.id, U(1), START_MS + 10, []);
      const rows = await f.store.inclusionByStore([STORES[0], STORES[2]], a.createdAtMs, c.createdAtMs + 1);
      expect(rows).toEqual([
        { storeId: STORES[0], outfits: 3, distinctShoppers: 2, addedToBagOutfits: 1 },
        { storeId: STORES[2], outfits: 0, distinctShoppers: 0, addedToBagOutfits: 0 },
      ]);
      expect((await f.store.inclusionByStore([STORES[0]], a.createdAtMs, a.createdAtMs + 1))[0]?.outfits).toBe(1);
    });

    it("counts generations (not outfits) per user since a time", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      const gen = U(300);
      await f.store.insertOutfits([record(1, U(1), { generationId: gen }), record(2, U(1), { generationId: gen }), record(3, U(1), { generationId: U(301) })], []);
      await f.store.insertOutfits([record(4, U(2), { generationId: U(302) })], []);
      expect(await f.store.countSince(U(1), 0)).toBe(2);
      expect(await f.store.countSince(U(2), 0)).toBe(1);
      expect(await f.store.countSince(U(1), START_MS + 10_000_000)).toBe(0);
    });

    it("marks added-to-bag once and emits the event once", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const r = record(1, U(1));
      await f.store.insertOutfits([r], []);
      const ev = [{ type: "outfit.added_to_bag" as const, outfitId: r.id, userId: U(1), itemCount: 2 }];
      expect(await f.store.markAddedToBag(r.id, U(1), START_MS + 5, ev)).toBe("marked");
      expect(await f.store.markAddedToBag(r.id, U(1), START_MS + 6, ev)).toBe("already");
      expect((await f.eventTypes()).filter((t) => t === "outfit.added_to_bag")).toHaveLength(1);
      expect((await f.store.getOutfit(r.id))?.addedToBagAtMs).toBe(START_MS + 5);
    });

    it("keeps one feedback row per item (last signal wins)", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const r = record(1, U(1));
      await f.store.insertOutfits([r], []);
      const base = { outfitId: r.id, userId: U(1), itemId: sku(1) };
      await f.store.upsertFeedback({ id: U(400), ...base, signal: "like", atMs: START_MS }, []);
      await f.store.upsertFeedback({ id: U(401), ...base, signal: "dislike", atMs: START_MS + 1 }, []);
      const rows = await f.store.getFeedback(r.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.signal).toBe("dislike");
    });

    it("stores and updates the style vector, and erases everything for a user", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      expect(await f.store.getStyleVector(U(1))).toBeNull();
      await f.store.putStyleVector(U(1), [0.5, 0.5], START_MS);
      await f.store.putStyleVector(U(1), [1, 0], START_MS + 1);
      expect(await f.store.getStyleVector(U(1))).toEqual([1, 0]);
      const r = record(1, U(1));
      const other = record(2, U(2));
      await f.store.insertOutfits([r, other], []);
      await f.store.upsertFeedback({ id: U(400), outfitId: r.id, userId: U(1), itemId: sku(1), signal: "like", atMs: START_MS }, []);
      await f.store.eraseForUser(U(1));
      expect(await f.store.getOutfit(r.id)).toBeNull();
      expect(await f.store.getStyleVector(U(1))).toBeNull();
      expect(await f.store.getOutfit(other.id)).not.toBeNull();
    });

    it("emits outbox events with ids and enums only", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const r = record(1, U(1));
      await f.store.insertOutfits([r], [
        { type: "outfit.generated", userId: U(1), outfitIds: [r.id], count: 1, budgetBand: "1000_2999", latencyMs: 12, source: "ml" },
      ]);
      expect(await f.eventTypes()).toEqual(["outfit.generated"]);
    });
  });
}
