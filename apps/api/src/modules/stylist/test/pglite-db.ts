import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
type GatewayDb = Kysely<Record<string, never>>;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../../../packages/db/migrations");
const DB_PKG = resolve(HERE, "../../../../../../packages/db/package.json");

export interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** 0039 (and the chat tables 0066, 0067) need users (0006) and the helper functions and roles (0002, 0007). */
export const STYLIST_MIGRATION_FILES = [
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
  "0039_stylist.sql",
  "0066_stylist_chat.sql",
  "0067_stylist_chat_settings_quota.sql",
] as const;

export const migrationSql = (file: string): string => readFileSync(resolve(MIGRATIONS, file), "utf8");

export async function createStylistDatabase(): Promise<{ pg: PgliteLike; db: GatewayDb }> {
  const req = createRequire(DB_PKG);
  const mod = (await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href)) as {
    PGlite: new () => PgliteLike;
  };
  const pg = new mod.PGlite();
  for (const f of STYLIST_MIGRATION_FILES) {
    await pg.exec(migrationSql(f).replace(/\bCREATE (UNIQUE )?INDEX CONCURRENTLY\b/gi, "CREATE $1INDEX"));
  }
  const db = new Kysely<Record<string, never>>({
    dialect: new PGliteDialect(pg as unknown as ConstructorParameters<typeof PGliteDialect>[0]),
  });
  return { pg, db };
}
