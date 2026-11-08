import type { OutboxEvent } from "./event.js";

/** Minimal SQL ports (structurally satisfied by @outlet/db's Queryable and SqlClient). */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- row type is a caller-asserted result shape, same as pg/PGlite
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}
export interface SqlClient extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Appends an event using the caller's open transaction handle. */
export interface TransactionalWriter<Tx = Queryable> {
  insertEvent(tx: Tx, event: OutboxEvent): Promise<void>;
}

/** Delivers one event to the queue/bus. Must throw on failure. At-least-once: may be called again for the same id. */
export interface Publisher {
  publish(event: OutboxEvent): Promise<void>;
}
