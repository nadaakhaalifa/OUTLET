import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createBudgetDatabase, migrationSql, type PgliteLike } from "./test/pglite-db";
import type { BudgetDb } from "./adapters/kysely-store";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg: PgliteLike;
let db: BudgetDb;

beforeAll(async () => {
  ({ pg, db } = await createBudgetDatabase());
  await pg.query(`insert into users (id, status) values ($1,'active'), ($2,'active')`, [U(1), U(2)]);
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

describe("0038_budget", () => {
  it("passes the migration linter", () => {
    expect(lintMigration(migrationSql("0038_budget.sql"))).toEqual([]);
  });

  it("is expand only: new tables, no DROP and no ALTER of existing tables", () => {
    const sql = readFileSync(new URL("../../../../../packages/db/migrations/0038_budget.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER TABLE (?!\w+ ENABLE ROW LEVEL SECURITY)/i);
  });

  it("holds every money and free text column as ciphertext (bytea), never a number", async () => {
    const r = await pg.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_name in ('budgets','budget_cycles','budget_spend_events','installment_commitments','savings_goals')
         and column_name in ('amount','per_category','spent','refunded','refund_received','detail','monthly','title','target_amount')`,
    );
    expect(r.rows.length).toBe(9);
    expect(r.rows.filter((x) => x.data_type !== "bytea")).toEqual([]);
  });

  it("has RLS enabled on every budget table and cascades from users", async () => {
    const names = ["budgets", "budget_cycles", "budget_spend_events", "installment_commitments", "savings_goals", "budget_unlock_requests"];
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1)`,
      [names],
    );
    expect(rls.rows.map((x) => x.relrowsecurity)).toEqual(names.map(() => true));
    await pg.query(`insert into budgets (user_id, amount, payday) values ($1, '\\x01', 25)`, [U(1)]);
    await pg.query(`insert into budget_unlock_requests (id, user_id, requested_at, unlock_at) values ($1,$2,now(), now() + interval '24 hours')`, [U(50), U(1)]);
    await pg.query(`delete from users where id = $1`, [U(1)]);
    const left = await pg.query(`select 1 from budgets where user_id = $1`, [U(1)]);
    expect(left.rows).toHaveLength(0);
    const left2 = await pg.query(`select 1 from budget_unlock_requests where user_id = $1`, [U(1)]);
    expect(left2.rows).toHaveLength(0);
  });

  it("refuses invalid paydays, cap modes and an unlock delay shorter than 24 hours", async () => {
    await expect(pg.query(`insert into budgets (user_id, amount, payday) values ($1, '\\x01', 32)`, [U(2)])).rejects.toThrow(/check/);
    await expect(pg.query(`insert into budgets (user_id, amount, payday, cap_mode) values ($1, '\\x01', 5, 'strict')`, [U(2)])).rejects.toThrow(/check/);
    await expect(
      pg.query(`insert into budget_unlock_requests (id, user_id, requested_at, unlock_at) values ($1,$2,now(), now() + interval '23 hours')`, [U(51), U(2)]),
    ).rejects.toThrow(/check/);
  });
});
