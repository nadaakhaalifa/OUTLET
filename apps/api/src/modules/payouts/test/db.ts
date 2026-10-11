import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";

export const MIGRATION_0035 = fileURLToPath(
  new URL("../../../../../../packages/db/migrations/0035_payouts_reconciliation.sql", import.meta.url),
);

/**
 * PGlite with migrations 1..11 (roles, ledger, outbox, RLS, identity) plus 0035 applied directly.
 * 0035 depends on nothing above 0011, and applying it by file keeps this suite independent of the
 * numbering gap another module's in-flight migration (0032) leaves below it.
 */
export async function createPayoutsDatabase(): Promise<PGlite> {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(readFileSync(MIGRATION_0035, "utf8"));
  return raw;
}
