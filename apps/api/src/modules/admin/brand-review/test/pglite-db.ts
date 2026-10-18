import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { BrandReviewDb } from "../kysely-overlay";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../../../../packages/db/migrations");
const DB_PKG = resolve(HERE, "../../../../../../../packages/db/package.json");

export interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** 0054 needs the helpers and RLS (0002, 0007). */
export const OVERLAY_MIGRATION_FILES = ["0001_extensions.sql", "0002_roles_and_helpers.sql", "0054_brand_review_overlay.sql"] as const;

export const migrationSql = (file: string): string => readFileSync(resolve(MIGRATIONS, file), "utf8");

export async function createOverlayDatabase(): Promise<{ pg: PgliteLike; db: BrandReviewDb }> {
  const req = createRequire(DB_PKG);
  const mod = (await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href)) as { PGlite: new () => PgliteLike };
  const pg = new mod.PGlite();
  for (const f of OVERLAY_MIGRATION_FILES) await pg.exec(migrationSql(f));
  const db = new Kysely<Record<string, never>>({ dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]) });
  return { pg, db };
}
