import { afterAll, describe, expect, it } from "vitest";
import { KyselyReviewStore, type ReviewDb } from "./kysely-store";
import { createReviewDatabase, type PgliteLike } from "../test/pglite-db";
import { U, describeReviewStoreContract, review } from "../test/repository-contract";

const open: ReviewDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createReviewDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyReviewStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeReviewStoreContract("kysely/pglite", fresh);

describe("KyselyReviewStore specifics", () => {
  it("enforces schema invariants the adapter relies on", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await expect(c.store.insertReview(review(1, U(1), { rating: 6 }), [])).rejects.toThrow();
    await expect(c.store.insertReview(review(2, U(1), { body: "short" }), [])).rejects.toThrow();
    await expect(c.store.insertReview(review(3, U(1), { fitArea: "waist", fit: null }), [])).rejects.toThrow();
    // HELD without a reason is refused by CHECK
    await expect(c.store.insertReview(review(4, U(1), { status: "HELD", holdReason: null }), [])).rejects.toThrow();
    // PUBLISHED without published_at is refused by CHECK
    await expect(c.store.insertReview(review(5, U(1), { status: "PUBLISHED", publishedAtMs: null }), [])).rejects.toThrow();
  });

  it("outbox payloads carry ids and enums only, never review text", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const r = review(1, U(1), { body: "very private text about my body size" });
    await c.store.insertReview(r, [
      { type: "review.published", reviewId: r.id, productId: r.productId, storeId: r.storeId, rating: 4 },
    ]);
    const rows = await c.pg.query<{ payload: unknown }>(`select payload from outbox_events`);
    expect(JSON.stringify(rows.rows)).not.toContain("private");
  });

  it("row level security: published is public, drafts are author only, replies are not writable by users", async () => {
    const c = await fresh();
    for (const n of [1, 2, 3]) await c.ensureUser(U(n));
    await c.store.insertReview(review(1, U(1)), []);
    await c.store.insertReview(review(2, U(1), { status: "PUBLISHED", publishedAtMs: 1_800_000_000_000 }), []);
    const pg: PgliteLike = c.pg;
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await pg.exec(
        `set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`,
      );
      try {
        return await pg.query(stmt);
      } finally {
        await pg.exec(`reset role`);
      }
    };
    expect((await asUser(U(1), `select id from reviews`)).rows).toHaveLength(2);
    expect((await asUser(U(2), `select id from reviews`)).rows).toHaveLength(1);
    expect((await asUser(U(2), `update reviews set rating = 1 where id = '${U(102)}' returning id`)).rows).toHaveLength(0);
    await expect(
      asUser(
        U(2),
        `insert into review_replies (review_id, store_id, author_user_id, body, status) values ('${U(102)}', '${U(9001)}', '${U(2)}', 'x', 'SUBMITTED')`,
      ),
    ).rejects.toThrow();
  });
});
