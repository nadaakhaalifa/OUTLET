/**
 * Adversarial audit of Phase 1 wave 1. Every test here encodes a CONFIRMED defect and is expected
 * to FAIL against the current source. Do not weaken them; fix the source instead.
 *
 *   ADV-1  sizing: seller demand k-anonymity counts requests, not distinct shoppers
 *   ADV-2  notifications: marketing frequency cap is a check-then-act race
 *   ADV-3  inventory: seller stock "set" ignores units allocated to the Fawry pool (phantom stock)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAWRY_POOL_ID, KyselyInventoryStore, STANDARD_POOL_ID } from "./modules/inventory";
import { createInventoryDatabase, type PgliteLike } from "./modules/inventory/test/pglite-db";
import { LOC_A, SKU_A1, STORE_A } from "./modules/inventory/test/fixtures";
import type { InventoryDb } from "./modules/inventory/adapters/kysely-store";
import { buildRig, cairo, U1 } from "./modules/notifications/test/support";
import {
  BRAND_X,
  PRODUCT_1,
  STORE_A as SIZING_STORE_A,
  TOKENS,
  TOPS_ROWS,
  USER_A,
  auth,
  createSizingHarness,
  type SizingHarness,
} from "./modules/sizing/test/harness";

describe("ADV-1 size demand k-anonymity must count distinct shoppers", () => {
  let h: SizingHarness;
  beforeAll(async () => {
    h = await createSizingHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("one shopper hitting /fit/recommend 50 times must not open a demand cell to the seller", async () => {
    h.catalog.seed({ productId: PRODUCT_1, storeId: SIZING_STORE_A, brandId: BRAND_X, productType: "tops", stretch: "none" });
    h.consent.grant(USER_A);
    const chart = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerOwnerA))
      .send({ product_type: "tops", unit: "cm", rows: TOPS_ROWS });
    expect(chart.status).toBe(201);
    const profile = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "Me", kind: "me", measurements: { bust_cm: 86, waist_cm: 68 } });
    expect(profile.status).toBe(201);

    for (let i = 0; i < 50; i += 1) {
      const r = await h
        .http()
        .get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${profile.body.id as string}`)
        .set(auth(TOKENS.buyerA));
      expect(r.status).toBe(200);
    }

    const demand = await h.http().get("/v1/seller/size-demand").set(auth(TOKENS.sellerOwnerA));
    expect(demand.status).toBe(200);
    // A single person produced every one of those 50 counts: nothing may be released at k = 50.
    expect(demand.body.items).toEqual([]);
  });
});

describe("ADV-2 marketing frequency cap must hold under concurrent sends", () => {
  it("two concurrent marketing sends to one user deliver at most perDay (1) push", async () => {
    const r = await buildRig(cairo("2027-01-15", 12));
    r.consent.grant(U1, "marketing_push");
    await r.registerToken.execute(U1, {
      installId: "0192f3a4-5b6c-4d8e-9f01-23456789abcd",
      platform: "ios",
      token: "ExponentPushToken[adversarial-1]",
    });
    await Promise.all([
      r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "drop-a", payload: {} }),
      r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "drop-b", payload: {} }),
      r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "drop-c", payload: {} }),
    ]);
    expect(r.push.sent.length).toBeLessThanOrEqual(r.sender.caps.perDay);
  });
});

describe("ADV-3 seller stock set must not create stock out of the Fawry allocation", () => {
  let pg: PgliteLike;
  let db: InventoryDb;
  let store: KyselyInventoryStore;
  const NOW = 1_800_000_000_000;
  const USER = "00000000-0000-4000-8000-000000000701";

  beforeAll(async () => {
    ({ pg, db } = await createInventoryDatabase());
    store = new KyselyInventoryStore(db);
    await pg.exec(`insert into users (id, status) values ('${USER}', 'active')`);
    await pg.exec(`insert into locations (id, store_id, kind, name) values ('${LOC_A}', '${STORE_A}', 'SELLER_WAREHOUSE', 'A')`);
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
  });

  it("physical count 10, 4 allocated to Fawry, seller re-syncs set 10: total sellable stays 10", async () => {
    const base = {
      skuId: SKU_A1,
      locationId: LOC_A,
      storeId: STORE_A,
      reason: "recount" as const,
      actorType: "seller" as const,
      actorId: "seller-1",
      nowMs: NOW,
    };
    const first = await store.applySync({ ...base, poolId: STANDARD_POOL_ID, mode: "set", quantity: 10, idempotencyKey: "adv-1" });
    expect(first.status).toBe("applied");
    const moved = await store.transfer({
      skuId: SKU_A1,
      locationId: LOC_A,
      fromPoolId: STANDARD_POOL_ID,
      toPoolId: FAWRY_POOL_ID,
      storeId: STORE_A,
      qty: 4,
      idempotencyKey: "adv-t-1",
      nowMs: NOW,
    });
    expect(moved.status).toBe("transferred");

    // The seller (or a Shopify/Woo channel) reports the same physical count again.
    const again = await store.applySync({ ...base, poolId: STANDARD_POOL_ID, mode: "set", quantity: 10, idempotencyKey: "adv-2" });
    expect(again.status).toBe("applied");

    const std = await store.levelView(SKU_A1, LOC_A, STANDARD_POOL_ID);
    const fawry = await store.levelView(SKU_A1, LOC_A, FAWRY_POOL_ID);
    const sellable = (std?.onHand ?? 0) + (fawry?.onHand ?? 0);
    expect(sellable).toBeLessThanOrEqual(10);
  });
});
