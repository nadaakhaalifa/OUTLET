import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createTestDatabaseUpTo, defaultMigrationsDir } from "@outlet/db";
import type { NotificationsDb } from "../adapters/kysely-store";

type PGlite = Awaited<ReturnType<typeof createTestDatabaseUpTo>>;

/** Platform baseline 0001..0011, then 0018 by name (0012..0017 belong to other modules and are not needed). */
export async function createNotificationsDatabase(): Promise<{ pg: PGlite; db: NotificationsDb }> {
  const pg = await createTestDatabaseUpTo(11);
  await pg.exec(await readFile(join(defaultMigrationsDir(), "0018_notifications.sql"), "utf8"));
  const db = new Kysely<Record<string, never>>({
    dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]),
  });
  return { pg, db };
}
