import { afterAll, describe, expect, it } from "vitest";
import { createStylistDatabase } from "../test/pglite-db";
import { U, record, sku } from "../test/fixtures";
import { describeStylistStoreContract } from "../test/store-contract";
import { KyselyStylistStore, type StylistDb } from "./kysely-store";

const open: StylistDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const fresh = async () => {
  const { pg, db } = await createStylistDatabase();
  open.push(db);
  return {
    pg,
    store: new KyselyStylistStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
};

describeStylistStoreContract("kysely/pglite", fresh);

describe("migration 0039 constraints and RLS", () => {
  it("refuses an outfit whose total exceeds its stored budget", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await expect(c.store.insertOutfits([record(1, U(1), { totalPiastres: 200_000n, budgetPiastres: 100_000n })], [])).rejects.toThrow();
  });

  it("outbox payloads carry no item titles or user free text", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const r = record(1, U(1));
    await c.store.insertOutfits([r], [
      { type: "outfit.generated", userId: U(1), outfitIds: [r.id], count: 1, budgetBand: "none", latencyMs: 1, source: "rules" },
    ]);
    const rows = await c.pg.query<{ payload: unknown }>(`select payload from outbox_events`);
    expect(JSON.stringify(rows.rows)).not.toMatch(/title|note|budgetPiastres/);
  });

  it("row level security: outfits, feedback and vectors are owner only", async () => {
    const c = await fresh();
    for (const n of [1, 2]) await c.ensureUser(U(n));
    const r = record(1, U(1));
    await c.store.insertOutfits([r], []);
    await c.store.upsertFeedback({ id: U(500), outfitId: r.id, userId: U(1), itemId: sku(1), signal: "like", atMs: 1_800_000_000_000 }, []);
    await c.store.putStyleVector(U(1), [1, 0], 1_800_000_000_000);
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
      try {
        return await c.pg.query(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    for (const t of ["outfits", "stylist_feedback", "user_style_vectors"]) {
      expect((await asUser(U(1), `select 1 from ${t}`)).rows).toHaveLength(1);
      expect((await asUser(U(2), `select 1 from ${t}`)).rows).toHaveLength(0);
    }
    expect((await asUser(U(2), `update outfits set added_to_bag_at = now() returning id`)).rows).toHaveLength(0);
    await expect(asUser(U(2), `insert into product_attributes (product_id, attrs, model_version) values ('${U(1)}', '{}', 'v1')`)).rejects.toThrow();
    expect((await asUser(U(2), `select 1 from product_attributes`)).rows).toHaveLength(0);
  });
});
