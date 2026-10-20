import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { money } from "../domain/bridge";
import { promotionsDatabase } from "../test/pglite-db";
import { describePromotionRepositoryContract, record, U } from "../test/repository-contract";
import { KyselyPromotionRepository, type PromotionDb } from "./kysely-store";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await promotionsDatabase();
  const db: PromotionDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    repo: new KyselyPromotionRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describePromotionRepositoryContract("kysely/pglite", fresh);

describe("KyselyPromotionRepository specifics", () => {
  it("stores money as exact bigint piastres and the day key as a date", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const p = record({ value: { kind: "fixed", amount: money(9_007_199_254_740_993n) }, scope: "order" });
    await c.repo.insert(p);
    const r = await c.raw.query<{ a: string }>(`select fixed_amount::text as a from promotions`);
    expect(r.rows[0]?.a).toBe("9007199254740993");
    await c.repo.recordRedemptions([
      {
        promotionId: p.id,
        promotionVersion: 1,
        userId: U(1),
        orderGroupId: U(1),
        amount: 7n,
        platformFunded: 7n,
        sellerFunded: 0n,
        dayKey: "2027-03-04",
        atMs: 1_800_000_000_000,
      },
    ]);
    const d = await c.raw.query<{ d: string }>(`select day_key::text as d from promotion_redemptions`);
    expect(d.rows[0]?.d).toBe("2027-03-04");
  });

  it("the database itself rejects an inconsistent promotion (funding, owner, code xor auto, kind payload)", async () => {
    const c = await fresh();
    const base = `insert into promotions (owner_kind, store_id, kind, scope, code, auto_apply, title_ar,
      funding_platform_pct, funding_seller_pct, percent_bp, starts_at, ends_at, created_by) values`;
    const ok = `('platform', null, 'percent', 'order', 'OKCODE', false, 'x', 100, 0, 1000, now(), now() + interval '1 day', '${U(1)}')`;
    await c.raw.exec(`${base} ${ok}`);
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'order', 'BADFUND', false, 'x', 60, 60, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('store', '${U(5)}', 'percent', 'order', 'PLATFUND', false, 'x', 50, 50, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', '${U(5)}', 'percent', 'order', 'ORPHAN', false, 'x', 100, 0, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'order', 'BOTHXOR', true, 'x', 100, 0, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'order', null, false, 'x', 100, 0, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'shipping', 'WRONGSC', false, 'x', 100, 0, 1000, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'order', 'NOVALUE1', false, 'x', 100, 0, null, now(), now() + interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(
      c.raw.exec(`${base} ('platform', null, 'percent', 'order', 'BADWIN', false, 'x', 100, 0, 1000, now(), now() - interval '1 day', '${U(1)}')`),
    ).rejects.toThrow();
    await expect(c.raw.exec(`${base} ${ok}`)).rejects.toThrow(/unique|duplicate/i);
  });
});
