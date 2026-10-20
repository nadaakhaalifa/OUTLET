import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, "../../../../../../packages/db/migrations");
const DB_PKG = resolve(HERE, "../../../../../../packages/db/package.json");

export interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** Every migration (0001..latest), so purge SQL runs against the real schema, triggers and foreign keys. */
export async function createFullDatabase(): Promise<{ pg: PgliteLike; db: Kysely<Record<string, never>> }> {
  const mod = (await import(pathToFileURL(createRequire(DB_PKG).resolve("@electric-sql/pglite")).href)) as { PGlite: new () => PgliteLike };
  const pg = new mod.PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8").replace(/\bCREATE (UNIQUE )?INDEX CONCURRENTLY\b/gi, "CREATE $1INDEX"));
  }
  return { pg, db: new Kysely<Record<string, never>>({ dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]) }) };
}

export function migratedTables(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
    for (const m of readFileSync(resolve(MIGRATIONS_DIR, f), "utf8").matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) out.add((m[1] ?? "").toLowerCase());
  }
  return out;
}
