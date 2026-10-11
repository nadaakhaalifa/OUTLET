import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";

export const MIGRATION_0035 = fileURLToPath(
  new URL("../../../../../../packages/db/migrations/0035_payouts_reconciliation.sql", import.meta.url),
);

/** PGlite with migrations 1..11 plus 0035 applied by file (see the payouts module test db helper). */
export async function createReconDatabase(): Promise<PGlite> {
  const raw = await createTestDatabaseUpTo(11);
  await raw.exec(readFileSync(MIGRATION_0035, "utf8"));
  return raw;
}
