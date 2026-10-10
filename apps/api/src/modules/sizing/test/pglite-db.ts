import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createTestDatabaseUpTo, defaultMigrationsDir } from "@outlet/db";
import type { SizingDb } from "../adapters/kysely-store";

type PGlite = Awaited<ReturnType<typeof createTestDatabaseUpTo>>;

/** Platform baseline 0001..0011, then the two files sizing needs by name (0013 stores for the FK, 0017 itself). */
export async function createSizingDatabase(): Promise<{ pg: PGlite; db: SizingDb }> {
  const pg = await createTestDatabaseUpTo(11);
  for (const name of ["0013_stores", "0017_sizing"]) {
    await pg.exec(await readFile(join(defaultMigrationsDir(), `${name}.sql`), "utf8"));
  }
  const db = new Kysely<Record<string, never>>({
    dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]),
  });
  return { pg, db };
}
