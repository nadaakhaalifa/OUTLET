import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { money } from "../domain/bridge";
import { KyselyCartRepository, type CartDb } from "./kysely-store";
import { describeCartRepositoryContract, U } from "../test/repository-contract";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createTestDatabaseUpTo(15);
  const db: CartDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    repo: new KyselyCartRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeCartRepositoryContract("kysely/pglite", fresh);

describe("KyselyCartRepository specifics", () => {
  it("stores price_at_add as exact bigint piastres", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const cart = await c.repo.getOrCreate(U(1), U(101), 1_800_000_000_000);
    await c.repo.save(
      {
        ...cart,
        lines: [{
          id: U(301), skuId: U(401), storeId: U(501), qty: 1, priceAtAdd: money(9_007_199_254_740_993n),
          thresholdAtAdd: null, state: "IN_BAG", source: null, unavailableSinceMs: null, addedAtMs: 1_800_000_000_000,
        }],
      },
      0,
      1_800_000_000_001,
    );
    const r = await c.raw.query<{ p: string }>(`select price_at_add_amount::text as p from cart_lines`);
    expect(r.rows[0]?.p).toBe("9007199254740993");
  });

  it("surfaces the 50-line cap from the database and rolls the save back", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const cart = await c.repo.getOrCreate(U(1), U(101), 1_800_000_000_000);
    const mk = (n: number) => ({
      id: U(1000 + n), skuId: U(2000 + n), storeId: U(501), qty: 1, priceAtAdd: money(100n),
      thresholdAtAdd: null, state: "IN_BAG" as const, source: null, unavailableSinceMs: null,
      addedAtMs: 1_800_000_000_000 + n,
    });
    await expect(
      c.repo.save({ ...cart, lines: Array.from({ length: 51 }, (_, i) => mk(i)) }, 0, 1_800_000_000_001),
    ).rejects.toThrow(/50 lines/);
    const back = await c.repo.getOrCreate(U(1), U(101), 1_800_000_000_002);
    expect(back.version).toBe(0);
    expect(back.lines).toEqual([]);
  });
});
