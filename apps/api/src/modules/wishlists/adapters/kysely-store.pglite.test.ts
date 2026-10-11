import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyWishlistRepository, type WishlistDb } from "./kysely-store";
import { describeWishlistRepositoryContract, U } from "../test/repository-contract";

const open: Kysely<Record<string, never>>[] = [];

/** Fresh migrated database per test: 0001..0015 are contiguous, so the real runner applies them. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(15);
  const db: WishlistDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    db,
    repo: new KyselyWishlistRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeWishlistRepositoryContract("kysely/pglite", fresh);

describe("KyselyWishlistRepository specifics", () => {
  it("stores the share hash as 32 raw bytes, never as text", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.repo.insert({
      id: U(100), userId: U(1), intent: "need", title: "t", targetDate: null, budget: null, giftFor: null,
      coolOffEnabled: false,
      share: { tokenHash: "ef".repeat(32), createdAtMs: 1_800_000_000_000, expiresAtMs: null, revokedAtMs: null, hidePrices: false },
      createdAtMs: 1_800_000_000_000, updatedAtMs: 1_800_000_000_000,
    });
    const r = await c.raw.query<{ n: number; h: string }>(
      `select length(share_token_hash) as n, encode(share_token_hash,'hex') as h from wishlists`,
    );
    expect(r.rows[0]).toEqual({ n: 32, h: "ef".repeat(32) });
  });

  it("rejects a second list with the same share hash (one token, one list)", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const base = {
      userId: U(1), intent: "need" as const, title: "t", targetDate: null, budget: null, giftFor: null,
      coolOffEnabled: false, createdAtMs: 1_800_000_000_000, updatedAtMs: 1_800_000_000_000,
      share: { tokenHash: "aa".repeat(32), createdAtMs: 1, expiresAtMs: null, revokedAtMs: null, hidePrices: false },
    };
    await c.repo.insert({ ...base, id: U(100) });
    await expect(c.repo.insert({ ...base, id: U(101) })).rejects.toThrow();
  });
});
