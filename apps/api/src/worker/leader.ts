import type { Queryable } from "@outlet/db";

/**
 * Transaction-scoped leader election (ADR-0016): true when this transaction holds the advisory lock for `key` until it ends. Session-level advisory
 * locks are not usable through PgBouncer in transaction mode (the session is not ours), so leadership lasts one transaction: whoever holds the lock
 * does the work, the others skip. The key is hashed to bigint by Postgres (hashtextextended), so any text key works.
 */
export const tryLeaderTx = async (tx: Queryable, key: string): Promise<boolean> => {
  const r = await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [key]);
  return r.rows[0]?.ok === true;
};
