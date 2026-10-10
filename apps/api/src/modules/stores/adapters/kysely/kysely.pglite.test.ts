import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStore, uuid } from "../../test/fixtures";
import {
  USER_1,
  USER_2,
  describeStoresRepositoryContract,
} from "../../test/contract/repositories.contract";
import { createStoresPglite, type StoresPglite } from "../../test/pglite-fixture";
import { InMemoryFavoriteRepository, InMemoryStoreActivityFeed, InMemoryStoreRepository } from "../in-memory";
import { STORES_COLUMNS } from "./schema";

describeStoresRepositoryContract("in-memory", async () => {
  const feed = new InMemoryStoreActivityFeed();
  return {
    stores: new InMemoryStoreRepository(),
    favorites: new InMemoryFavoriteRepository(),
    feed,
    recordActivity: async (storeId, ms) => feed.record(storeId, ms),
    addUser: async () => undefined,
    close: async () => undefined,
  };
});
describeStoresRepositoryContract("kysely + pglite (system session)", createStoresPglite);

const SELLER_A = { userId: uuid(7101), role: "seller", storeIds: [uuid(30)] } as const;
const SELLER_B = { userId: uuid(7102), role: "seller", storeIds: [uuid(31)] } as const;
const CUSTOMER_1 = { userId: USER_1, role: "customer" } as const;
const CUSTOMER_2 = { userId: USER_2, role: "customer" } as const;
const ANON = { userId: null, role: null } as const;

describe("stores RLS context (kysely + pglite, role app_user)", () => {
  let h: StoresPglite;
  const live = makeStore(30, { slug: "live-a" });
  const draftB = makeStore(31, { slug: "draft-b", status: "DRAFT", sellerKycState: "DRAFT" });
  const suspended = makeStore(32, { slug: "susp", status: "SUSPENDED" });
  beforeAll(async () => {
    h = await createStoresPglite();
    for (const s of [live, draftB, suspended]) await h.stores.save(s);
    await h.addUser(USER_1);
    await h.addUser(USER_2);
    await h.favorites.replace(USER_1, [{ storeId: live.id, position: 0, lastSeenAtMs: 1_800_000_000_000 }]);
    await h.favorites.replace(USER_2, [{ storeId: live.id, position: 0, lastSeenAtMs: 1_800_000_000_000 }]);
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("a shopper sees only trading, approved stores", async () => {
    h.setSession(CUSTOMER_1);
    expect((await h.stores.all()).map((s) => s.id)).toEqual([live.id]);
    expect(await h.stores.findById(draftB.id)).toBeNull();
    expect(await h.stores.findById(suspended.id)).toBeNull();
  });

  it("a seller sees its own tenant (even draft) and never another tenant's draft", async () => {
    h.setSession(SELLER_B);
    expect((await h.stores.findById(draftB.id))?.id).toBe(draftB.id);
    h.setSession(SELLER_A);
    expect(await h.stores.findById(draftB.id)).toBeNull();
    expect(await h.stores.findById(suspended.id)).toBeNull();
  });

  it("an anonymous session sees only the public directory (policy public-read), never drafts or suspended stores", async () => {
    h.setSession(ANON);
    expect((await h.stores.all()).map((s) => s.id)).toEqual([live.id]);
    expect(await h.favorites.list(USER_1)).toEqual([]);
    expect(await h.feed.occurredAtMsByStore([live.id])).toEqual(new Map([[live.id, []]]));
  });

  it("a seller cannot un-suspend its store or change platform-owned columns", async () => {
    h.setSession({ userId: uuid(7103), role: "seller", storeIds: [suspended.id] });
    await expect(h.stores.save({ ...suspended, status: "ACTIVE" })).rejects.toThrow(/platform/);
    await expect(h.stores.save({ ...suspended, verifiedBadge: false })).rejects.toThrow(/platform/);
  });

  it("a seller may edit presentation fields of its own store only", async () => {
    h.setSession(SELLER_A);
    await h.stores.save({ ...live, descriptionAr: "وصف جديد" });
    expect((await h.stores.findById(live.id))?.descriptionAr).toBe("وصف جديد");
    h.setSession(SELLER_B);
    await expect(h.stores.save({ ...live, descriptionAr: "اختراق" })).rejects.toThrow();
    h.setSession(SELLER_A);
    expect((await h.stores.findById(live.id))?.descriptionAr).toBe("وصف جديد");
  });

  it("a shopper cannot create a store", async () => {
    h.setSession(CUSTOMER_1);
    await expect(h.stores.save(makeStore(40, { slug: "intruder" }))).rejects.toThrow();
  });

  it("favourites are private: another user reads nothing and cannot write for you", async () => {
    h.setSession(CUSTOMER_2);
    expect(await h.favorites.list(USER_1)).toEqual([]);
    await expect(
      h.favorites.replace(USER_1, [{ storeId: live.id, position: 0, lastSeenAtMs: 1_800_000_000_000 }]),
    ).rejects.toThrow();
    h.setSession(CUSTOMER_1);
    expect(await h.favorites.list(USER_1)).toHaveLength(1);
    // A stranger's delete is filtered to zero rows by RLS and must not have removed the favourite.
    h.setSession(CUSTOMER_2);
    await h.favorites.replace(USER_1, []).catch(() => undefined);
    h.setSession(CUSTOMER_1);
    expect(await h.favorites.list(USER_1)).toHaveLength(1);
  });

  it("follower counts are aggregate only, whoever asks", async () => {
    h.setSession(SELLER_A);
    expect(Object.fromEntries(await h.favorites.followerCounts())).toEqual({ [live.id]: 2 });
  });

  it("a shopper cannot append activity events", async () => {
    h.setSession(CUSTOMER_1);
    await expect(h.feed.record(live.id, "drop_scheduled", 1_800_000_000_000)).rejects.toThrow();
  });

  it("column maps match information_schema (drift)", async () => {
    for (const [table, expected] of Object.entries(STORES_COLUMNS)) {
      const r = await h.raw.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name`,
        [table],
      );
      expect(r.rows.map((x) => x.column_name), table).toEqual([...expected]);
    }
  });
});
