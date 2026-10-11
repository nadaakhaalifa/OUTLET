import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);

export const MIGRATION_SQL = readFileSync(fileURLToPath(new URL("0022_fulfillment.sql", DIR)), "utf8");

/**
 * A fresh PGlite with the platform migrations 0001-0011 and 0022. The migrations in between belong
 * to other modules and 0022 depends only on 0001-0011 (loadMigrations() rejects directory gaps,
 * so the files are read directly, the same way the cart migration test does).
 */
export async function freshFulfillmentDatabase(): Promise<PGlite> {
  const db = new PGlite();
  const names = readdirSync(fileURLToPath(DIR))
    .filter((f) => /^00(0[1-9]|1[01])_/.test(f))
    .sort();
  const base = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8")));
  await migrate(withoutConcurrently(db), base);
  await db.exec(MIGRATION_SQL);
  return db;
}
