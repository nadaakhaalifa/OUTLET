import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { U, I, describeWardrobeStoreContract, item, upload } from "../test/store-contract";
import { KyselyWardrobeStore, type WardrobeDb } from "./kysely-store";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: WardrobeDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-9000-${String(++seq).padStart(12, "0")}` };

/** 0081 and 0082 depend only on 0001-0011 (helpers, RLS roles, users, outbox): other modules cannot break them. */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(read("0081_wardrobe_items.sql"));
  await raw.exec(read("0082_wardrobe_blob_graveyard.sql"));
  const db: WardrobeDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const pg = raw as unknown as { query<T>(s: string, p?: unknown[]): Promise<{ rows: T[] }> };
  return {
    pg,
    store: new KyselyWardrobeStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    graveyard: async () => (await pg.query<{ upload_id: string }>(`select upload_id from wardrobe_blob_graveyard`)).rows.map((r) => r.upload_id),
    eventTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeWardrobeStoreContract("kysely/pglite", fresh);

describe("migrations 0081 and 0082", () => {
  it("pass the migration linter and are additive", () => {
    for (const f of ["0081_wardrobe_items.sql", "0082_wardrobe_blob_graveyard.sql"]) {
      const sql = read(f);
      expect(lintMigration(sql)).toEqual([]);
      const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    }
  });

  it("enables RLS on all three tables and keeps the graveyard away from the application role", async () => {
    const c = await fresh();
    const r = await c.pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('wardrobe_items','wardrobe_uploads','wardrobe_blob_graveyard')`,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    const g = await c.pg.query<{ has: boolean }>(`select has_table_privilege('app_user', 'wardrobe_blob_graveyard', 'SELECT') as has`);
    expect(g.rows[0]?.has).toBe(false);
  });

  it("enforces row checks: photo reference and state agree, attributes are an object, caps on size", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const ins = (cols: string, vals: unknown[]) =>
      c.pg.query(`insert into wardrobe_items (id, user_id, ${cols}) values ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(", ")})`, [I(1), U(1), ...vals]);
    await expect(ins("image_ref, image_state", ["wardrobe/2026/10/abcdefabcdef", "none"])).rejects.toThrow(/check/);
    await expect(ins("image_state", ["clean"])).rejects.toThrow(/check/);
    await expect(ins("attributes", ["[]"])).rejects.toThrow(/check/);
    await expect(ins("attributes_source", ["robot"])).rejects.toThrow(/check/);
    await expect(c.pg.query(`insert into wardrobe_uploads (id, user_id, upload_id, content_type, size_bytes) values ($1,$2,'wardrobe/2026/10/abcdef','image/gif',10)`, [I(2), U(1)])).rejects.toThrow(/check/);
    await expect(c.pg.query(`insert into wardrobe_uploads (id, user_id, upload_id, content_type, size_bytes) values ($1,$2,'wardrobe/2026/10/abcdef','image/png',10485761)`, [I(2), U(1)])).rejects.toThrow(/check/);
  });

  it("the graveyard trigger catches erasure paths that bypass the application (delete by user_id)", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const up = upload(1, U(1));
    await c.store.insertUpload(up, 5);
    await c.store.insertItem(item(1, U(1), { imageRef: up.uploadId, imageState: "clean" }), up.uploadId, 10, []);
    await c.store.insertUpload(upload(2, U(1)), 5);
    await c.pg.query(`delete from wardrobe_items where user_id = $1`, [U(1)]);
    await c.pg.query(`delete from wardrobe_uploads where user_id = $1`, [U(1)]);
    const keys = await c.graveyard();
    expect(keys).toContain(up.uploadId);
    expect(keys).toContain(upload(2, U(1)).uploadId);
    expect(keys).toHaveLength(2);
  });

  it("hides one shopper's rows from another under the application role (RLS)", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.ensureUser(U(2));
    await c.store.insertItem(item(1, U(1)), null, 10, []);
    await c.pg.query(`set role app_user`);
    await c.pg.query(`select set_config('app.user_id', $1, false)`, [U(2)]);
    const r = await c.pg.query<{ n: number }>(`select count(*)::int as n from wardrobe_items`);
    await c.pg.query(`reset role`);
    expect(r.rows[0]?.n).toBe(0);
  });
});
