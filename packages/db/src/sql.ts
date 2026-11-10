/** Minimal SQL ports. Real drivers and PGlite both adapt to these. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- row type is a caller-asserted result shape, same as pg/PGlite
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface SqlClient extends Queryable {
  /** Runs fn in one transaction: commit on resolve, roll back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Executes a multi-statement script (no parameters). */
export interface ScriptExecutor {
  exec(sql: string): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- row type is a caller-asserted result shape, same as pg/PGlite
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}
