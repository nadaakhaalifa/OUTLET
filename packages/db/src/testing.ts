import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "./migrate.js";
import type { Queryable, SqlClient } from "./sql.js";

/**
 * TEST ONLY. In-memory PGlite (single-connection WASM Postgres) with all
 * migrations applied. Transactions on one PGlite instance are serialised, so
 * tests here cannot prove real multi-connection SKIP LOCKED behaviour.
 */
export const createTestClient = async (): Promise<{ client: SqlClient; close: () => Promise<void> }> => {
  const db = new PGlite();
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
