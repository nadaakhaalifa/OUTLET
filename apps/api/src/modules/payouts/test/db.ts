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

/**
 * The shared touch_updated_at trigger stamps UPDATEs with clock_timestamp() (real wall time), while
 * scenarios drive an injected TestClock. Any real-time stamp that drifts past the test clock makes
 * date-dependent results (cycle keys, the 30-day summary window) change with the calendar.
 * This pins the stamp to the fixed scenario instant in the test database only; production migrations
 * are untouched.
 */
export async function pinUpdatedAt(raw: PGlite, fixedMs: number): Promise<void> {
  const iso = new Date(fixedMs).toISOString();
  await raw.exec(`
    CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := '${iso}'::timestamptz;
      RETURN NEW;
    END
    $$;`);
}
