import { sql, type Transaction } from "kysely";
import {
  ANONYMOUS_SESSION,
  STATEMENT_TIMEOUT_MS,
  assertProcessName,
  sessionSettings,
  type RlsSession,
  type TimeoutProfile,
} from "./deps";

export interface TxOptions {
  /** Identity for RLS. Omit only for jobs that run with no identity (every policy denies). */
  readonly session?: RlsSession;
  /** Business process, becomes application_name: `checkout.reserve`, `catalog.read`. */
  readonly process: string;
  readonly profile?: TimeoutProfile;
  /** Explicit override in ms (1..600000). Prefer a profile. */
  readonly statementTimeoutMs?: number;
}

export interface ResolvedTx {
  readonly session: RlsSession;
  readonly process: string;
  readonly timeoutMs: number;
}

export const resolveTxOptions = (o: TxOptions): ResolvedTx => {
  const timeoutMs = o.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS[o.profile ?? "default"];
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new RangeError("statement timeout must be an integer 1..600000 ms");
  }
  return { session: o.session ?? ANONYMOUS_SESSION, process: assertProcessName(o.process), timeoutMs };
};

/** Role names are interpolated as identifiers, so they are restricted to a safe shape. */
const ROLE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Configures the CURRENT transaction. Everything is transaction-local
 * (SET LOCAL / set_config(..., true)), which is what makes it safe under
 * PgBouncer transaction pooling: nothing survives COMMIT or ROLLBACK.
 *
 * Order matters: drop privileges to `app_user` first, so RLS applies to every
 * statement that follows, then set the request identity.
 */
export const applySession = async <DB>(trx: Transaction<DB>, r: ResolvedTx, applicationRole: string | null): Promise<void> => {
  const t = trx;
  if (applicationRole !== null) {
    if (!ROLE_IDENT.test(applicationRole)) throw new RangeError("invalid role name");
    await sql`SET LOCAL ROLE ${sql.id(applicationRole)}`.execute(t);
  }
  const pairs: (readonly [string, string])[] = [
    ...sessionSettings(r.session),
    ["application_name", r.process],
    ["statement_timeout", `${r.timeoutMs}ms`],
  ];
  const [first, ...rest] = pairs;
  if (first === undefined) return;
  // one round trip for all settings
  let q = sql`SELECT set_config(${first[0]}, ${first[1]}, true)`;
  for (const [k, v] of rest) q = sql`${q}, set_config(${k}, ${v}, true)`;
  await q.execute(t);
};

/** Runs `fn` with `app.role` elevated to `system`, restoring the caller's role afterwards. */
export const asSystemRole = async <DB, T>(trx: Transaction<DB>, fn: () => Promise<T>): Promise<T> => {
  const t = trx;
  const prev = await sql<{ r: string }>`SELECT coalesce(current_setting('app.role', true), '') AS r`.execute(t);
  await sql`SELECT set_config('app.role', 'system', true)`.execute(t);
  // On failure the transaction is aborted and will roll back: restoring would only mask the real error.
  const out = await fn();
  await sql`SELECT set_config('app.role', ${prev.rows[0]?.r ?? ""}, true)`.execute(t);
  return out;
};
