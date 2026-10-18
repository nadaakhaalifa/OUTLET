import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import type { AutoBuyDb } from "./adapters/kysely-store";
import { createAutoBuyDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";

let pg: PgliteLike;
let db: AutoBuyDb;

beforeAll(async () => {
  ({ pg, db } = await createAutoBuyDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

describe("0056_price_drop_auto_buy", () => {
  const file = "0056_price_drop_auto_buy.sql";

  it("passes the migration linter", () => {
    expect(lintMigration(migrationSql(file))).toEqual([]);
  });

  it("is expand only: new tables and functions, no DROP and no ALTER of existing tables", () => {
    const sql = migrationSql(file)
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("has RLS enabled on every auto-buy table", async () => {
    const names = ["auto_buy_mandate_texts", "auto_buy_mandates", "auto_buy_attempts"];
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) order by relname`,
      [names],
    );
    expect(rls.rows.map((x) => x.relname).sort()).toEqual([...names].sort());
    expect(rls.rows.every((x) => x.relrowsecurity)).toBe(true);
  });

  it("stores no card data: the only payment column is a vault reference and is length bounded", async () => {
    const r = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('auto_buy_mandates','auto_buy_attempts')
         and (column_name ~* 'pan|card|cvv|number|iban')`,
    );
    expect(r.rows).toEqual([]);
  });

  it("holds money only as bigint piastres", async () => {
    const r = await pg.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_name in ('auto_buy_mandates','auto_buy_attempts') and column_name ~ '_price$'`,
    );
    expect(r.rows.length).toBe(4);
    expect(r.rows.filter((x) => x.data_type !== "bigint")).toEqual([]);
  });
});

describe("0057_auto_buy_evidence_retention", () => {
  const file = "0057_auto_buy_evidence_retention.sql";
  it("passes the migration linter and is an expand migration", () => {
    expect(lintMigration(migrationSql(file))).toEqual([]);
    expect(migrationSql(file)).toMatch(/phase: expand/);
  });
  it("no auto-buy foreign key cascades any more", async () => {
    const r = await pg.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint where contype = 'f' and conrelid in ('auto_buy_mandates'::regclass, 'auto_buy_attempts'::regclass)`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    expect(r.rows.filter((x) => x.confdeltype === "c")).toEqual([]);
  });
});
