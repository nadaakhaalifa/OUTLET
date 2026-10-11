import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describePriceIntegrityContract, DAY, STORE_A, STORE_B, T0, U } from "./contract";
import { createPriceIntegrityPglite, type PriceIntegrityPglite } from "./pglite-fixture";

// The same suite, two adapters.
describePriceIntegrityContract("kysely + pglite (system session)", createPriceIntegrityPglite);

const SELLER_A = { userId: U(1), role: "seller", storeIds: [STORE_A] } as const;
const SELLER_B = { userId: U(2), role: "seller", storeIds: [STORE_B] } as const;
const CUSTOMER = { userId: U(3), role: "customer" } as const;
const ANON = { userId: null, role: null } as const;

const newEvent = (n: number, sku: number, store: string, price: bigint, at: number) => ({
  id: U(100 + n),
  skuId: U(sku),
  storeId: store,
  priceAmount: price,
  validFromMs: at,
  source: "seller" as const,
  actorId: U(1),
  idempotencyKey: `k${n}`,
});

describe("price-integrity RLS and immutability (kysely + pglite, role app_user)", () => {
  let h: PriceIntegrityPglite;
  beforeAll(async () => {
    h = await createPriceIntegrityPglite();
    h.setSession(SELLER_A);
    await h.events.append(newEvent(1, 1, STORE_A, 100_000n, T0));
    h.setSession({ userId: null, role: "system" });
    await h.claims.record({
      id: U(500), skuId: U(1), storeId: STORE_A, status: "none", priceAmount: 100_000n, vrpAmount: null, discountPct: null,
      evidenceIds: [], reason: "not_a_reduction", computedAtMs: T0,
    });
    await h.enforcement.record({
      id: U(600), storeId: STORE_A, skuId: U(1), kind: "pre_drop_inflation", actions: [{ kind: "hide_discount" }], violationsInWindow: 1,
      dedupeKey: "a", openedAtMs: T0, resolvedAtMs: null,
    });
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("any authenticated role reads public price history; anonymous reads nothing", async () => {
    h.setSession(CUSTOMER);
    expect(await h.events.history(U(1))).toHaveLength(1);
    h.setSession(ANON);
    expect(await h.events.history(U(1))).toHaveLength(0);
  });

  it("a foreign seller cannot write a price event for store A", async () => {
    h.setSession(SELLER_B);
    await expect(h.events.append(newEvent(2, 5, STORE_A, 5_000n, T0 + DAY))).rejects.toThrow();
    h.setSession(CUSTOMER);
    await expect(h.events.append(newEvent(3, 6, STORE_A, 5_000n, T0 + DAY))).rejects.toThrow();
  });

  it("claims and enforcement rows are visible only to their own store", async () => {
    h.setSession(SELLER_A);
    expect(await h.claims.statsSince(STORE_A, 0)).toEqual({ evaluated: 1, verified: 0 });
    expect((await h.enforcement.recent(STORE_A, 5)).map((r) => r.dedupeKey)).toEqual(["a"]);
    h.setSession(SELLER_B);
    expect(await h.claims.statsSince(STORE_A, 0)).toEqual({ evaluated: 0, verified: 0 });
    expect(await h.enforcement.recent(STORE_A, 5)).toEqual([]);
    expect(await h.enforcement.countSince(STORE_A, 0)).toBe(0);
    h.setSession(CUSTOMER);
    expect(await h.enforcement.recent(STORE_A, 5)).toEqual([]);
  });

  it("price_events and price_claims are append-only for every role, including the owner", async () => {
    await expect(h.raw.query(`update price_events set price_amount = 1`)).rejects.toThrow(/append-only/);
    await expect(h.raw.query(`delete from price_events`)).rejects.toThrow(/append-only/);
    await expect(h.raw.query(`truncate price_events`)).rejects.toThrow(/append-only/);
    await expect(h.raw.query(`update price_claims set price_amount = 1`)).rejects.toThrow(/append-only/);
    await expect(h.raw.query(`delete from price_claims`)).rejects.toThrow(/append-only/);
  });

  it("enforcement rows can only be resolved, once", async () => {
    await expect(h.raw.query(`update price_enforcement_actions set violations_in_window = 9`)).rejects.toThrow();
    await expect(h.raw.query(`delete from price_enforcement_actions`)).rejects.toThrow();
  });

  it("the schema itself refuses a percentage without a reference above the price", async () => {
    await expect(
      h.raw.query(
        `insert into price_claims (id, sku_id, store_id, status, price_amount, vrp_amount, discount_pct, evidence_ids, computed_at)
         values ($1,$2,$3,'none',100,150,33,'{}',now())`,
        [U(700), U(1), STORE_A],
      ),
    ).rejects.toThrow();
    await expect(
      h.raw.query(
        `insert into price_claims (id, sku_id, store_id, status, price_amount, vrp_amount, discount_pct, evidence_ids, computed_at)
         values ($1,$2,$3,'verified_discount',100,90,10,'{x}',now())`,
        [U(701), U(1), STORE_A],
      ),
    ).rejects.toThrow();
    await expect(
      h.raw.query(
        `insert into price_events (id, sku_id, store_id, price_amount, valid_from, source, idempotency_key)
         values ($1,$2,$3,0,now(),'seller','z')`,
        [U(702), U(9), STORE_A],
      ),
    ).rejects.toThrow();
  });
});
