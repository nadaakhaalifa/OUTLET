import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "./migrate.js";
import { brandClient } from "./roles.js";
import type { DbRole, RoleSqlClient } from "./roles.js";
import type { Queryable, ScriptExecutor, SqlClient } from "./sql.js";

/**
 * TEST ONLY. Mirrors infra/local/postgres/init/001-roles.sql for PGlite: the runtime roles (NOLOGIN) and the
 * default privileges (outlet_app only; outlet_auth and outlet_worker get explicit grants from migration 0007).
 * Idempotent. Must run before applyMigrations (migration 0007 refuses to run without the roles).
 */
export const bootstrapTestRoles = async (db: ScriptExecutor): Promise<void> => {
  await db.exec(`
    DO $$
    DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY ARRAY['outlet_app', 'outlet_auth', 'outlet_worker'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', r);
        END IF;
      END LOOP;
    END $$;
    GRANT USAGE ON SCHEMA public TO outlet_app, outlet_auth, outlet_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO outlet_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO outlet_app;
  `);
};

/**
 * TEST ONLY. Runs fn in one transaction as `role` (SET LOCAL ROLE; PGlite itself is superuser).
 * Bind a context inside with applyDbContext(tx, ctx).
 */
export const asRole = <T>(client: SqlClient, role: DbRole, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  client.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  });

/** TEST ONLY. A client whose every statement and transaction runs as `role`, usable with withDbContext. */
export const roleClient = <R extends DbRole>(client: SqlClient, role: R): RoleSqlClient<R> =>
  brandClient<R>({
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
      query: <Row extends object>(sql: string, params?: readonly unknown[]) => asRole(client, role, (tx) => tx.query<Row>(sql, params)),
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) => asRole(client, role, fn),
  });

/**
 * TEST ONLY. In-memory PGlite (single-connection WASM Postgres) with all
 * migrations applied. Transactions on one PGlite instance are serialised, so
 * tests here cannot prove real multi-connection SKIP LOCKED behaviour.
 */
export const createTestClient = async (): Promise<{ client: SqlClient; close: () => Promise<void> }> => {
  const db = new PGlite();
  await bootstrapTestRoles(db);
  await applyMigrations(db);
  const client: SqlClient = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: async <R extends object>(sql: string, params?: readonly unknown[]) => {
      const r = await db.query<R>(sql, params ? [...params] : []);
      return { rows: r.rows };
    },
    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      db.transaction((t) =>
        fn({
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
          query: async <R extends object>(sql: string, params?: readonly unknown[]) => {
            const r = await t.query<R>(sql, params ? [...params] : []);
            return { rows: r.rows };
          },
        }),
      ),
  };
  return { client, close: () => db.close() };
};

/** Runs fn against a fresh migrated database and always closes it. */
export const withTestDb = async <T>(fn: (client: SqlClient) => Promise<T>): Promise<T> => {
  const { client, close } = await createTestClient();
  try {
    return await fn(client);
  } finally {
    await close();
  }
};
