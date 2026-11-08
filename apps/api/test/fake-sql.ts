import { brandClient } from "@outlet/db";
import type { Queryable, SqlClient } from "@outlet/db";

export type Script = (sql: string, params: readonly unknown[]) => readonly object[] | undefined;
export interface Fake { readonly stmts: { sql: string; params: readonly unknown[] }[] }

/** Scripted SqlClient: statements the script does not answer (context setup) return no rows. */
export const fakeClient = <R extends "outlet_app" | "outlet_worker" = "outlet_app">(script: Script): { client: ReturnType<typeof brandClient<R>>; log: Fake } => {
  const log: Fake = { stmts: [] };
  const q: Queryable = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <Row extends object>(sql: string, params: readonly unknown[] = []) => {
      log.stmts.push({ sql, params });
      return Promise.resolve({ rows: (script(sql, params) ?? []) as Row[] });
    },
  };
  const sql: SqlClient = { query: (s, p) => q.query(s, p), transaction: <T>(fn: (tx: Queryable) => Promise<T>) => fn(q) };
  return { client: brandClient<R>(sql), log };
};
export const U1 = "00000000-0000-4000-8000-000000000001";
export const M1 = "00000000-0000-4000-8000-0000000000aa";
export const S1 = "00000000-0000-4000-8000-000000000002";
