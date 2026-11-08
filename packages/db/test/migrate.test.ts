import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations } from "../src/index.js";
import { withTestDb } from "../src/testing.js";

describe("migrations", () => {
  it("loads the shipped migrations in order", async () => {
    const list = await loadMigrations();
    expect(list.map((m) => m.name)[0]).toBe("0001_outbox_inbox_idempotency");
  });

  it("is idempotent: second run applies nothing", async () => {
    const db = new PGlite();
    expect(await applyMigrations(db)).toEqual(["0001_outbox_inbox_idempotency"]);
    expect(await applyMigrations(db)).toEqual([]);
    await db.close();
  });

  it("rejects a modified, already-applied migration", async () => {
    const db = new PGlite();
    await applyMigrations(db, [{ name: "0001_a", sql: "CREATE TABLE a (x int);" }]);
    await expect(applyMigrations(db, [{ name: "0001_a", sql: "CREATE TABLE a (x bigint);" }])).rejects.toThrow(/modified/);
    await db.close();
  });

  it("rolls back a failing migration entirely", async () => {
    const db = new PGlite();
    await expect(applyMigrations(db, [{ name: "0001_bad", sql: "CREATE TABLE t (x int); SELECT nope();" }])).rejects.toThrow();
    await db.exec("ROLLBACK").catch(() => undefined);
    const r = await db.query("SELECT to_regclass('t') AS t");
    expect(r.rows[0]).toEqual({ t: null });
    await db.close();
  });

  it("rejects bad names and numbering gaps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    await writeFile(join(dir, "0002_x.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toThrow(/gap/);
    const dir2 = await mkdtemp(join(tmpdir(), "mig-"));
    await writeFile(join(dir2, "x.sql"), "SELECT 1;");
    await expect(loadMigrations(dir2)).rejects.toThrow(/bad migration/);
  });

  it("creates the kernel tables and enforces constraints", async () => {
    await withTestDb(async (c) => {
      const t = await c.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
      );
      expect(t.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(["dlq_messages", "idempotency_keys", "inbox_processed", "outbox_events"]),
      );
      await expect(
        c.query(
          "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES (gen_random_uuid(), 'EG', 'order', gen_random_uuid(), 'BadType', '{}', now())",
        ),
      ).rejects.toThrow();
    });
  });
});
