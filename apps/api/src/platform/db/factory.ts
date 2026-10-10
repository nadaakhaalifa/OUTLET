import { Kysely, PostgresDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import pg from "pg";
import { z } from "zod";

const PgConfig = z
  .object({
    connectionString: z.string().min(1),
    /** Pool size. Checkout and analytics get separate pools (spec 20.2: isolated checkout pool). */
    max: z.number().int().min(1).max(100).default(10),
    idleTimeoutMs: z.number().int().min(1_000).default(30_000),
    connectionTimeoutMs: z.number().int().min(100).default(5_000),
    /** Default application_name before a transaction tags its business process. */
    applicationName: z.string().min(1).max(63).default("outlet-api"),
  })
  .strict();
export type PgConfig = z.input<typeof PgConfig>;

/**
 * Production factory: Kysely over a pg Pool. The pool must connect as a LOGIN
 * role that is a member of `app_user` (migration 0002); never as the table
 * owner or a superuser, both of which bypass RLS. The Pool connects lazily.
 */
export function createPgDatabase<DB>(input: PgConfig): Kysely<DB> {
  const c = PgConfig.parse(input);
  const pool = new pg.Pool({
    connectionString: c.connectionString,
    max: c.max,
    idleTimeoutMillis: c.idleTimeoutMs,
    connectionTimeoutMillis: c.connectionTimeoutMs,
    application_name: c.applicationName,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** The PGlite instance type, without importing @electric-sql/pglite (not a dependency of apps/api). */
export type PgliteInstance = ConstructorParameters<typeof PGliteDialect>[0];

/**
 * Test factory: Kysely over an in-memory PGlite. DEVELOPMENT AND TEST ONLY.
 * PGlite has ONE connection: do not use the root handle inside a transaction
 * callback (it queues behind the open transaction and deadlocks).
 */
export function createPgliteDatabase<DB>(pglite: PgliteInstance): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PGliteDialect(pglite) });
}
