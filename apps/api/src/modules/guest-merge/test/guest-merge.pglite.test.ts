/**
 * The Postgres unit of work (PGlite, every migration incl. 0097): cart + wishlists + outbox commit or roll back
 * together, the merged_guest source is accepted by the CHECK, and a lost race retries without a partial write.
 */
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { FakeCatalog, StaticPlatformConfig, type BagView } from "../../cart";
import { InMemoryCatalogRead } from "../../wishlists";
import { KyselyGuestMergeUnitOfWork } from "../adapters/kysely-uow";
import { InMemoryRecentlyViewedWriter, StaticPersonalizationConsent } from "../adapters/in-memory";
import { MergeGuest } from "../application/merge-guest";
import { MergeConflictError, type GuestMergeUnitOfWork } from "../domain/ports";


const id = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const USER = id(1);
const STORE = id(2);
const EGP = (p: bigint) => ({ amount: p * 100n, currency: "EGP" as const });
const NOW = 1_800_000_000_000;

let raw: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
let db: Kysely<Record<string, never>>;
let catalog: FakeCatalog;
let products: InMemoryCatalogRead;
let seq = 100;
const next = (): string => id(++seq);

const makeMerge = (uow: GuestMergeUnitOfWork) =>
  new MergeGuest({
    uow,
    catalog: () => catalog,
    platform: () => new StaticPlatformConfig(),
    products: () => products,
    readCart: async (): Promise<BagView> => ({ cartId: "c", updatedAtMs: NOW, lineCount: 0, groups: [] }),
    consent: () => new StaticPersonalizationConsent(),
    viewed: () => new InMemoryRecentlyViewedWriter(),
    clock: { nowMs: () => NOW },
    ids: { uuidV7: next, hex: (n: number) => "a".repeat(n * 2) },
  });

const addSku = (pounds = 100n): { sku: string; product: string } => {
  const sku = next();
  const product = next();
  catalog.addSku({ skuId: sku, productId: product, storeId: STORE, title: { ar: "قميص" }, unitPrice: EGP(pounds), available: true });
  products.seed({ id: product, listed: true, currentPrice: EGP(pounds), skuIds: [sku], summary: { id: product } });
  return { sku, product };
};
const count = async (sql: string): Promise<number> => Number((await raw.query<{ n: string }>(sql)).rows[0]?.n ?? 0);

beforeAll(async () => {
  raw = await createTestDatabaseUpTo(9999);
  db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  await raw.query(`insert into users (id, status) values ($1, 'active')`, [USER]);
  catalog = new FakeCatalog();
  catalog.addStore(STORE);
  products = new InMemoryCatalogRead();
}, 120_000);
afterAll(async () => {
  await db.destroy();
});

describe("KyselyGuestMergeUnitOfWork", () => {
  it("commits cart lines (source merged_guest, server price), the Saved item and the outbox row together", async () => {
    const a = addSku(250n);
    const b = addSku(40n);
    const uow = new KyselyGuestMergeUnitOfWork(db, { uuidV7: next });
    const r = await makeMerge(uow).execute({
      userId: USER,
      bag: [{ skuId: a.sku, qty: 3, savedForLater: false, addedAtMs: 1 }],
      saved: [{ productId: b.product, skuId: b.sku, intent: "treat" }],
      viewed: [],
    });
    expect(r.lines[0]).toMatchObject({ result: "added", qty: 3 });
    const lines = await raw.query<{ qty: number; source: string; price: string }>(
      `select qty, source, price_at_add_amount::text as price from cart_lines`,
    );
    expect(lines.rows).toEqual([{ qty: 3, source: "merged_guest", price: "25000" }]);
    expect(await count(`select count(*) as n from wishlist_items`)).toBe(1);
    const ev = await raw.query<{ event_type: string; payload: { user_id: string; counts: Record<string, number> } }>(
      `select event_type, payload from outbox_events where event_type = 'cart.guest_merged'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.payload.user_id).toBe(USER);
    expect(ev.rows[0]?.payload.counts).toMatchObject({ added: 1, saved_added: 1 });
    expect(JSON.stringify(ev.rows[0]?.payload)).not.toContain(a.sku);
  });

  it("rolls EVERYTHING back when anything inside the unit of work fails (no half merge)", async () => {
    const uow = new KyselyGuestMergeUnitOfWork(db, { uuidV7: next });
    const before = {
      lines: await count(`select count(*) as n from cart_lines`),
      lists: await count(`select count(*) as n from wishlists`),
      outbox: await count(`select count(*) as n from outbox_events`),
    };
    const c = addSku();
    await expect(
      uow.run(USER, async (tx) => {
        const cart = await tx.cart.getOrCreate(USER, next(), NOW);
        await tx.cart.save(
          {
            ...cart,
            lines: [
              ...cart.lines,
              { id: next(), skuId: c.sku, storeId: STORE, qty: 1, priceAtAdd: EGP(1n), thresholdAtAdd: null, state: "IN_BAG", source: "merged_guest", unavailableSinceMs: null, addedAtMs: NOW },
            ],
          },
          cart.version,
          NOW,
        );
        await tx.emit({ type: "cart.guest_merged", userId: USER, cartId: cart.id, counts: { added: 1, qtyRaised: 0, movedToSaved: 0, unavailable: 0, storeSuspended: 0, savedAdded: 0 } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count(`select count(*) as n from cart_lines`)).toBe(before.lines);
    expect(await count(`select count(*) as n from wishlists`)).toBe(before.lists);
    expect(await count(`select count(*) as n from outbox_events`)).toBe(before.outbox);
  });

  it("a concurrent cart write makes the first attempt lose, the merge retries and ends consistent", async () => {
    const d = addSku();
    const inner = new KyselyGuestMergeUnitOfWork(db, { uuidV7: next });
    let raced = false;
    // Another device writes the bag between our read and our write: bump the version just before our CAS.
    const racing: GuestMergeUnitOfWork = {
      run: (u, fn) =>
        inner.run(u, (tx) =>
          fn({
            ...tx,
            cart: {
              ...tx.cart,
              getOrCreate: (...a) => tx.cart.getOrCreate(...a),
              save: async (...a) => {
                if (!raced) {
                  raced = true;
                  await raw.query(`update carts set version = version + 1 where user_id = $1`, [USER]);
                }
                return tx.cart.save(...a);
              },
            },
          }),
        ),
    };
    const r = await makeMerge(racing).execute({
      userId: USER,
      bag: [{ skuId: d.sku, qty: 2, savedForLater: false, addedAtMs: 1 }],
      saved: [],
      viewed: [],
    });
    expect(raced).toBe(true);
    expect(r.lines[0]?.result).toBe("added");
    const q = await raw.query<{ qty: number }>(`select qty from cart_lines where sku_id = $1`, [d.sku]);
    expect(q.rows).toEqual([{ qty: 2 }]);
  });

  it("gives up with a conflict after three lost races and writes nothing", async () => {
    const e = addSku();
    const inner = new KyselyGuestMergeUnitOfWork(db, { uuidV7: next });
    const always: GuestMergeUnitOfWork = {
      run: (u, fn) =>
        inner.run(u, (tx) =>
          fn({
            ...tx,
            cart: {
              ...tx.cart,
              getOrCreate: (...a) => tx.cart.getOrCreate(...a),
              save: async (...a) => {
                await raw.query(`update carts set version = version + 1 where user_id = $1`, [USER]);
                return tx.cart.save(...a);
              },
            },
          }),
        ),
    };
    await expect(
      makeMerge(always).execute({ userId: USER, bag: [{ skuId: e.sku, qty: 1, savedForLater: false, addedAtMs: 1 }], saved: [], viewed: [] }),
    ).rejects.toBeInstanceOf(MergeConflictError);
    expect(await count(`select count(*) as n from cart_lines where sku_id = '${e.sku}'`)).toBe(0);
  });

  it("two concurrent merges of one account create ONE default list (advisory lock) and one item", async () => {
    const f = addSku();
    const inner = new KyselyGuestMergeUnitOfWork(db, { uuidV7: next });
    const input = { userId: USER, bag: [], saved: [{ productId: f.product, skuId: f.sku, intent: "need" as const }], viewed: [] };
    await Promise.all([makeMerge(inner).execute(input), makeMerge(inner).execute(input)]);
    expect(await count(`select count(*) as n from wishlists where user_id = '${USER}' and intent = 'need'`)).toBe(1);
    expect(await count(`select count(*) as n from wishlist_items where product_id = '${f.product}'`)).toBe(1);
  });
});

