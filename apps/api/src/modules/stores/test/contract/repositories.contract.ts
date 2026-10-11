import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FavoriteRepository, StoreActivityFeed, StoreRepository } from "../../domain/ports";
import { EMPTY_STATS, makeStore, uuid } from "../fixtures";

export interface StoresContractHarness {
  readonly stores: StoreRepository;
  readonly favorites: FavoriteRepository;
  readonly feed: StoreActivityFeed;
  /** Test-side arrangement: append one activity event. */
  recordActivity(storeId: string, occurredAtMs: number): Promise<void>;
  /** Test-side arrangement: make a user id valid for favourites (FK to users). */
  addUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

export const USER_1 = uuid(7001);
export const USER_2 = uuid(7002);

export function describeStoresRepositoryContract(label: string, make: () => Promise<StoresContractHarness>): void {
  describe(`stores repository contract: ${label}`, () => {
    let h: StoresContractHarness;
    beforeEach(async () => {
      h = await make();
      await h.addUser(USER_1);
      await h.addUser(USER_2);
    });
    afterEach(async () => {
      await h.close();
    });

    it("round-trips a store with stats and public legal identity", async () => {
      const s = makeStore(1, {
        kind: "global",
        healthScore: 72,
        freeDeliveryThresholdAmount: 350_050n,
        logoUrl: "https://cdn.invalid/l.png",
        descriptionAr: "وصف المتجر",
        nameEn: null,
        stats: { maxVerifiedDiscountPct: 40, ratingAvg: 4.25, ratingCount: 18, liveDrop: true, trendingScore: 9, lastDropAtMs: 1_800_000_000_000, p80DeliveryHours: 48 },
      });
      await h.stores.save(s);
      expect(await h.stores.findById(s.id)).toEqual(s);
      expect(await h.stores.findById(uuid(999))).toBeNull();
    });

    it("stores with no legal identity and empty stats come back as such", async () => {
      const s = makeStore(2, { legalIdentity: null, status: "DRAFT", sellerKycState: "DRAFT", stats: EMPTY_STATS });
      await h.stores.save(s);
      expect(await h.stores.findById(s.id)).toEqual(s);
    });

    it("saving a store with legalIdentity null clears a previously saved public identity", async () => {
      const s = makeStore(20);
      await h.stores.save(s);
      expect((await h.stores.findById(s.id))?.legalIdentity).not.toBeNull();
      await h.stores.save({ ...s, legalIdentity: null });
      expect((await h.stores.findById(s.id))?.legalIdentity).toBeNull();
    });

    it("save is an upsert that persists lifecycle changes", async () => {
      const s = makeStore(3);
      await h.stores.save(s);
      await h.stores.save({ ...s, status: "SUSPENDED", verifiedBadge: false, sellerKycState: "SUSPENDED" });
      const got = await h.stores.findById(s.id);
      expect(got).toMatchObject({ status: "SUSPENDED", verifiedBadge: false, sellerKycState: "SUSPENDED" });
      expect((await h.stores.all()).length).toBe(1);
    });

    it("lists all stores and finds them by seller", async () => {
      const a = makeStore(4, { sellerId: uuid(8001) });
      const b = makeStore(5, { sellerId: uuid(8001) });
      const c = makeStore(6, { sellerId: uuid(8002) });
      for (const s of [a, b, c]) await h.stores.save(s);
      expect((await h.stores.all()).map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort());
      expect((await h.stores.bySeller(uuid(8001))).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
      expect(await h.stores.bySeller(uuid(8003))).toEqual([]);
    });

    it("replaces favourites atomically, keeps order and counts followers per store", async () => {
      const [a, b, c] = [makeStore(10), makeStore(11), makeStore(12)];
      for (const s of [a, b, c]) await h.stores.save(s);
      await h.favorites.replace(USER_1, [
        { storeId: b.id, position: 0, lastSeenAtMs: 1_800_000_000_000 },
        { storeId: a.id, position: 1, lastSeenAtMs: 1_800_000_005_000 },
      ]);
      await h.favorites.replace(USER_2, [{ storeId: a.id, position: 0, lastSeenAtMs: 1_800_000_000_000 }]);
      expect((await h.favorites.list(USER_1)).map((r) => [r.storeId, r.position, r.lastSeenAtMs])).toEqual([
        [b.id, 0, 1_800_000_000_000],
        [a.id, 1, 1_800_000_005_000],
      ]);
      expect(Object.fromEntries(await h.favorites.followerCounts())).toEqual({ [a.id]: 2, [b.id]: 1 });

      // Reorder + drop one: positions are rewritten, counts follow.
      await h.favorites.replace(USER_1, [{ storeId: a.id, position: 0, lastSeenAtMs: 1_800_000_009_000 }]);
      expect((await h.favorites.list(USER_1)).map((r) => r.storeId)).toEqual([a.id]);
      expect(Object.fromEntries(await h.favorites.followerCounts())).toEqual({ [a.id]: 2 });

      await h.favorites.replace(USER_1, []);
      expect(await h.favorites.list(USER_1)).toEqual([]);
      expect(await h.favorites.list(USER_2)).toHaveLength(1);
    });

    it("reports activity timestamps per store, empty for quiet stores", async () => {
      const a = makeStore(20);
      const b = makeStore(21);
      await h.stores.save(a);
      await h.stores.save(b);
      await h.recordActivity(a.id, 1_800_000_002_000);
      await h.recordActivity(a.id, 1_800_000_001_000);
      const got = await h.feed.occurredAtMsByStore([a.id, b.id]);
      expect([...(got.get(a.id) ?? [])].sort()).toEqual([1_800_000_001_000, 1_800_000_002_000]);
      expect(got.get(b.id)).toEqual([]);
    });
  });
}
