import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { InventoryDb } from "../adapters/kysely-store";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../../../packages/db/migrations");
const DB_PKG = resolve(HERE, "../../../../../../packages/db/package.json");

/** Minimal structural view of PGlite: apps/api does not list it as a direct dependency. */
export interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/**
 * Migrations needed by 0016: 0001..0011 (extensions, roles, ledger, outbox, audit, identity, RLS)
 * then 0016 itself. Files 0012..0015 belong to other modules and are not required, so this test
 * does not go through the sequential runner (which refuses gaps). CREATE INDEX CONCURRENTLY is
 * built plain because PGlite has one backend.
 */
export const INVENTORY_MIGRATION_FILES = [
  "0001_extensions.sql",
  "0002_roles_and_helpers.sql",
  "0003_ledger.sql",
  "0004_idempotency_outbox_inbox.sql",
  "0005_audit_log.sql",
  "0006_identity_consent.sql",
  "0007_rls_and_grants.sql",
  "0008_outbox_relay_and_saga.sql",
  "0009_outbox_indexes.sql",
  "0010_ledger_owner_bank.sql",
  "0011_ledger_account_types.sql",
  "0016_inventory.sql",
] as const;

export const migrationSql = (file: string): string => readFileSync(resolve(MIGRATIONS, file), "utf8");

export async function createInventoryDatabase(): Promise<{ pg: PgliteLike; db: InventoryDb }> {
  const req = createRequire(DB_PKG);
  const mod = (await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href)) as {
    PGlite: new () => PgliteLike;
  };
  const pg = new mod.PGlite();
  for (const f of INVENTORY_MIGRATION_FILES) {
    await pg.exec(migrationSql(f).replace(/\bCREATE (UNIQUE )?INDEX CONCURRENTLY\b/gi, "CREATE $1INDEX"));
  }
  const db = new Kysely<Record<string, never>>({
    dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]),
  });
  return { pg, db };
}
