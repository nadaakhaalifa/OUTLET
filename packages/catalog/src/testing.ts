import { brandClient } from "@outlet/db";
import type { DbRole, Queryable, RoleSqlClient } from "@outlet/db";

/** Statements the database context binder issues on every transaction; not business queries. */
const isContextBinding = (sql: string): boolean => sql.startsWith("SELECT set_config(");

export interface QueryCount<T> {
  readonly result: T;
  /** Business statements in execution order (context binding excluded). */
  readonly statements: readonly string[];
  readonly count: number;
}

/**
 * TEST ONLY. Runs fn with a client that records every statement, and returns the result with the statement list.
 * Used to prove "no N+1": assert `count` is a constant that does not grow with the number of rows returned.
 */
export const countQueries = async <R extends DbRole, T>(client: RoleSqlClient<R>, fn: (counted: RoleSqlClient<R>) => Promise<T>): Promise<QueryCount<T>> => {
  const statements: string[] = [];
  const wrap = (q: Queryable): Queryable => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <Row extends object>(sql: string, params?: readonly unknown[]) => {
      if (!isContextBinding(sql)) statements.push(sql);
      return q.query<Row>(sql, params);
    },
  });
  const counted = brandClient<R>({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <Row extends object>(sql: string, params?: readonly unknown[]) => wrap(client).query<Row>(sql, params),
    transaction: <U>(f: (tx: Queryable) => Promise<U>) => client.transaction((tx) => f(wrap(tx))),
  });
  const result = await fn(counted);
  return { result, statements, count: statements.length };
};

/** Asserts the exact statement count; throws with the statements listed so a failing test shows the offending query. */
export const expectQueryCount = async <R extends DbRole, T>(client: RoleSqlClient<R>, expected: number, fn: (counted: RoleSqlClient<R>) => Promise<T>): Promise<T> => {
  const r = await countQueries(client, fn);
  if (r.count !== expected) throw new Error(`expected exactly ${String(expected)} statements, got ${String(r.count)}:\n${r.statements.join("\n---\n")}`);
  return r.result;
};
