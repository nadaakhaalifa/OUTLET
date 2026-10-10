import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, migrate, type MigrateResult, type SqlExecutor } from './runner.js';

/**
 * PGlite runs one backend, and CREATE INDEX CONCURRENTLY fails there with
 * "tuple concurrently updated". Test databases therefore build the same
 * index non-concurrently. CONCURRENTLY behaviour is NOT verified on PGlite.
 */
export const withoutConcurrently = (db: PGlite): SqlExecutor => ({
  exec: (sql) => db.exec(sql.replace(/\bCREATE (UNIQUE )?INDEX CONCURRENTLY\b/gi, 'CREATE $1INDEX')),
  query: (sql, params) => db.query(sql, params),
});

/**
 * In-memory PGlite database with all migrations applied. DEVELOPMENT AND TEST
 * ONLY: PGlite is single-connection WASM Postgres, not production Postgres 16.
 */
export const createTestDatabase = async (): Promise<{ db: PGlite; result: MigrateResult }> => {
  const db = new PGlite();
  const result = await migrate(withoutConcurrently(db), await loadMigrations());
  return { db, result };
};
