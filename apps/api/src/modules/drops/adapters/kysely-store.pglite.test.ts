import { afterAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createDropsDatabase, migrationSql } from "../test/pglite-db";
import { DEVICE, T0, U, describeDropStoreContract, drop } from "../test/store-contract";
import { KyselyDropStore, type DropDb } from "./kysely-store";

const open: DropDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const fresh = async () => {
  const { pg, db } = await createDropsDatabase();
  open.push(db);
  return {
    pg,
    store: new KyselyDropStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
};

describeDropStoreContract("kysely/pglite", fresh);

describe("migration 0042_drops", () => {
  it("passes the migration linter and is expand only", () => {
    const sql = migrationSql("0042_drops.sql");
    expect(lintMigration(sql)).toEqual([]);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("enforces type invariants: early access only for members-only, mystery terms only for mystery boxes", async () => {
    const c = await fresh();
    await expect(c.store.insert(drop(1, { earlyAccessAtMs: T0 }), [])).rejects.toThrow();
    await expect(c.store.insert(drop(2, { type: "members_only", earlyAccessAtMs: null }), [])).rejects.toThrow();
    await expect(c.store.insert(drop(3, { type: "mystery_box", mystery: null }), [])).rejects.toThrow();
    await expect(c.store.insert(drop(4, { items: [{ skuId: U(7001), stockCap: 0, pricePiastres: 1n }] }), [])).rejects.toThrow();
  });

  it("a reservation can count once and an admission token lives exactly 15 minutes", async () => {
    const c = await fresh();
    const d = drop(5, { state: "LIVE" });
    await c.store.insert(d, []);
    await c.ensureUser(U(1));
    await c.pg.query(
      `insert into admission_tokens (jti, drop_id, user_id, device_hash, ticket_id, issued_at, expires_at)
       values ($1,$2,$3,$4,$5, now(), now() + interval '15 minutes')`,
      [U(600), d.id, U(1), DEVICE(1), U(601)],
    );
    await expect(
      c.pg.query(
        `insert into admission_tokens (jti, drop_id, user_id, device_hash, ticket_id, issued_at, expires_at)
         values ($1,$2,$3,$4,$5, now(), now() + interval '1 hour')`,
        [U(602), d.id, U(1), DEVICE(1), U(603)],
      ),
    ).rejects.toThrow();
  });

  it("row level security: DRAFT drops are invisible to app_user, queue rows are owner only", async () => {
    const c = await fresh();
    await c.store.insert(drop(6, { state: "DRAFT" }), []);
    await c.store.insert(drop(7, { state: "LIVE" }), []);
    for (const n of [1, 2]) await c.ensureUser(U(n));
    await c.pg.query(`insert into drop_waitlist (drop_id, user_id) values ($1, $2)`, [U(107), U(1)]);
    await c.pg.exec(`set role app_user; select set_config('app.role','user', false); select set_config('app.user_id','${U(2)}', false);`);
    try {
      const drops = await c.pg.query<{ id: string }>(`select id from drops`);
      expect(drops.rows.map((r) => r.id)).toEqual([U(107)]);
      const wl = await c.pg.query(`select 1 from drop_waitlist`);
      expect(wl.rows).toHaveLength(0);
      await expect(c.pg.query(`update drops set paused = true`)).resolves.toBeDefined();
      await c.pg.exec(`select set_config('app.user_id','${U(1)}', false)`);
      expect((await c.pg.query(`select 1 from drop_waitlist`)).rows).toHaveLength(1);
    } finally {
      await c.pg.exec(`reset role`);
    }
    const still = await c.pg.query<{ paused: boolean }>(`select paused from drops where id = $1`, [U(107)]);
    expect(still.rows[0]?.paused).toBe(false);
  });
});
