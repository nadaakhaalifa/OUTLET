import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = (f: string): string =>
  fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url));

/** The migration SQL as PGlite can run it (PGlite is single connection: CONCURRENTLY is built plainly). */
export const migrationSql = (file: string): string =>
  readFileSync(MIGRATIONS(file), "utf8").replace(/\bCREATE (UNIQUE )?INDEX CONCURRENTLY\b/gi, "CREATE $1INDEX");

/**
 * 0001-0011 (helpers, outbox, inbox, RLS roles) plus the seller analytics migrations 0028, 0088 and 0090. They depend on
 * nothing else, so other modules' in-flight migrations cannot break the suites that use this.
 */
export async function createRollupDatabase(): Promise<PGlite> {
  const raw = await createTestDatabaseUpTo(11);
  for (const f of ["0028_seller_analytics.sql", "0088_analytics_rollups.sql", "0090_analytics_facts_privacy.sql"]) await raw.exec(migrationSql(f));
  return raw;
}
