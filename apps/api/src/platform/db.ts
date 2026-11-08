import { brandClient, withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { pgConnectionTag } from "@outlet/observability";
import type { PgProcessName } from "@outlet/observability";
import type { ApiRequest } from "./http.js";
import { Problems } from "./problem.js";

/** The subset of `pg.Pool` used here (so the adapter is testable without a server). */
export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(err?: Error | boolean): void }>;
}

/**
 * Pool options per business process (BUILD-PROMPT §3, ADR-0011): `application_name` tags the pool in
 * pg_stat_activity and PgBouncer, and every connection is short-lived in transaction mode.
 */
export const pgPoolOptions = (connectionString: string, process: PgProcessName, max: number): Record<string, unknown> => ({
  connectionString,
  application_name: pgConnectionTag(process),
  max,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 2_000,
  // Defence in depth with the database default; the reserve path sets 2 s with SET LOCAL.
  statement_timeout: 10_000,
});

/** SqlClient over a pg pool; `transaction` is BEGIN/COMMIT on one connection, ROLLBACK on throw. */
export const pgSqlClient = <R extends "outlet_app">(pool: PoolLike): RoleSqlClient<R> =>
  brandClient<R>({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: async <Row extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await pool.query(sql, params ? [...params] : [])).rows as Row[] }),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      const conn = await pool.connect();
      const tx: Queryable = {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
        query: async <Row extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await conn.query(sql, params ? [...params] : [])).rows as Row[] }),
      };
      try {
        await conn.query("BEGIN");
        const out = await fn(tx);
        await conn.query("COMMIT");
        conn.release();
        return out;
      } catch (e) {
        try {
          await conn.query("ROLLBACK");
          conn.release();
        } catch {
          conn.release(true); // broken connection: destroy it instead of returning it to the pool
        }
        throw e;
      }
    },
  });

/** Runs fn in one transaction bound to this request's tenant context (SET LOCAL; never per session). */
export const runInRequestContext = <T>(client: RoleSqlClient<"outlet_app">, req: ApiRequest, fn: (tx: Queryable) => Promise<T>): Promise<T> => {
  const ctx = req.ctx.db;
  if (ctx === undefined) throw Problems.internal("db-context-missing");
  return withDbContext(client, ctx, fn);
};
