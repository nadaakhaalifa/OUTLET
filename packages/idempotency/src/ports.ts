/** Minimal SQL port (structurally satisfied by @outlet/db's Queryable). */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- row type is a caller-asserted result shape, same as pg/PGlite
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}
