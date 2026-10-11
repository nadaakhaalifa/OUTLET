import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0031_ledger_posting.sql", import.meta.url)),
  "utf8",
);
let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabaseUpTo(31);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0031_ledger_posting", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("creates the chain table with RLS on, immutable, and no grants beyond select and insert", async () => {
    const t = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where relname = 'ledger_entry_chain'`,
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    const g = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
       where table_name = 'ledger_entry_chain' and grantee = 'app_user' order by 1`,
    );
    expect(g.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });
});
