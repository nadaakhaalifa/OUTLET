import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);

/**
 * PGlite with migrations 0001-0011 (platform baseline) plus this module's 0021. Migrations 0012-0020
 * belong to other modules and are not needed (logical references only), so a numbering gap or another
 * module's in-flight migration cannot break these suites.
 */
export async function promotionsDatabase(): Promise<PGlite> {
  const names = readdirSync(fileURLToPath(DIR))
    .filter((f) => /^00(0[1-9]|1[01])_/.test(f) || /^0021_promotions\.sql$/.test(f))
    .sort();
  const files = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8")));
  const db = new PGlite();
  await migrate(withoutConcurrently(db), files);
  return db;
}

export const MIGRATION_SQL = readFileSync(fileURLToPath(new URL("0021_promotions.sql", DIR)), "utf8");
