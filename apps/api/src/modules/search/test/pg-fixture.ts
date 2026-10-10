import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);

export const SEARCH_MIGRATION = readFileSync(fileURLToPath(new URL("0023_search.sql", DIR)), "utf8");

/**
 * PGlite with migrations 0001-0011 plus 0023_search. Other modules' migrations (0012-0022) are in
 * flight in parallel and this one depends only on users and the role helpers, so read the baseline
 * directly (loadMigrations() rejects numbering gaps).
 */
export async function createSearchDatabase(opts: { trigram: boolean } = { trigram: true }): Promise<PGlite> {
  let extensions: Record<string, unknown> = {};
  if (opts.trigram) {
    const mod = (await import("@electric-sql/pglite/contrib/pg_trgm")) as { pg_trgm: unknown };
    extensions = { pg_trgm: mod.pg_trgm };
  }
  const db = new PGlite({ extensions } as ConstructorParameters<typeof PGlite>[0]);
  const names = readdirSync(fileURLToPath(DIR))
    .filter((f) => /^00(0[1-9]|1[01])_/u.test(f))
    .sort();
  const base = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8")));
  await migrate(withoutConcurrently(db), base);
  await db.exec(SEARCH_MIGRATION);
  return db;
}
