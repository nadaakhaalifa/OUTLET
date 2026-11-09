import type { DbRole, RoleSqlClient, UnbrandedSqlClient } from "./roles.js";
import type { Queryable, SqlClient } from "./sql.js";

export const WORKER_JOBS = ["outbox.relay", "privacy.deletion", "privacy.retention", "auth.purge", "media.platform", "seller.kyc", "payments.webhook", "checkout.expiry", "checkout.settle", "finance.refunds", "finance.payouts", "finance.reconcile", "search.sync", "notifications.dispatch", "orders.close", "pricing.channels", "shipping.tracking"] as const;
export type WorkerJob = (typeof WORKER_JOBS)[number];

/** Pre-auth lookup keys, lowercase hex (bidx/hash) or uuid (deviceId). Supply only what the step needs. */
export interface AuthKeys {
  readonly phoneBidx?: string;
  readonly installHash?: string;
  /** HMAC of the device id (age_blocks key); distinct from installHash, which hashes the install id. */
  readonly deviceHash?: string;
  readonly tokenHash?: string;
  readonly deviceId?: string;
}

export interface UserContext {
  readonly kind: "user"
  readonly marketId: string
  readonly userId?: string ;
}
export interface StoreContext {
  readonly kind: "store"
  readonly marketId: string
  readonly storeId: string
  readonly userId?: string ;
}
/** userId may be set once the user is known ("narrow, then act"): user policies then apply as well. */
export interface AuthContext {
  readonly kind: "auth"
  readonly marketId: string
  readonly userId?: string
  readonly auth?: AuthKeys ;
}
export interface WorkerContext {
  readonly kind: "worker"
  readonly marketId: string
  readonly job: WorkerJob
  readonly userId?: string ;
}
export type DbContext = UserContext | StoreContext | AuthContext | WorkerContext;

/** Which contexts each role may run in (compile-time). */
export type ContextFor<R extends DbRole> = R extends "outlet_app"
  ? UserContext | StoreContext
  : R extends "outlet_auth"
    ? AuthContext | UserContext
    : WorkerContext | UserContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^(?:[0-9a-f]{2}){1,64}$/i;

const uuidOrEmpty = (name: string, v: string | undefined): string => {
  if (v === undefined) return "";
  if (!UUID.test(v)) throw new Error(`invalid ${name} in database context`);
  return v;
};
const hexOrEmpty = (name: string, v: string | undefined): string => {
  if (v === undefined) return "";
  if (!HEX.test(v)) throw new Error(`invalid ${name} in database context`);
  return v.toLowerCase();
};

/** Every setting written on every call ('' when unset) so nothing is inherited from the connection. */
export const contextSettings = (ctx: DbContext): Record<string, string> => {
  if (ctx.marketId.length === 0) throw new Error("database context needs a marketId");
  const auth = ctx.kind === "auth" ? ctx.auth : undefined;
  if (ctx.kind === "worker" && !WORKER_JOBS.includes(ctx.job)) throw new Error(`unknown worker job ${ctx.job as string}`);
  return {
    "app.ctx": ctx.kind,
    "app.job": ctx.kind === "worker" ? ctx.job : "",
    "app.current_market_id": ctx.marketId,
    "app.current_user_id": uuidOrEmpty("userId", ctx.userId),
    "app.current_store_id": uuidOrEmpty("storeId", ctx.kind === "store" ? ctx.storeId : undefined),
    "app.auth_phone_bidx": hexOrEmpty("auth.phoneBidx", auth?.phoneBidx),
    "app.auth_install_hash": hexOrEmpty("auth.installHash", auth?.installHash),
    "app.auth_token_hash": hexOrEmpty("auth.tokenHash", auth?.tokenHash),
    "app.auth_device_hash": hexOrEmpty("auth.deviceHash", auth?.deviceHash),
    "app.auth_device_id": uuidOrEmpty("auth.deviceId", auth?.deviceId),
  };
};

/** Binds the context inside an already-open transaction (set_config(..., true) = SET LOCAL). */
export const applyDbContext = async (tx: Queryable, ctx: DbContext): Promise<void> => {
  const s = contextSettings(ctx);
  const keys = Object.keys(s);
  const sql = `SELECT ${keys.map((_, i) => `set_config($${String(2 * i + 1)}, $${String(2 * i + 2)}, true)`).join(", ")}`;
  await tx.query(sql, keys.flatMap((k) => [k, s[k] ?? ""]));
};

/**
 * Narrow, then act: once the user is known (found or just created), bind app.current_user_id in the open
 * transaction so user-isolation policies apply to the remaining statements. Every other setting (ctx, market,
 * auth keys) is left untouched; the transaction must already have a context.
 */
export const narrowContext = async (tx: Queryable, narrow: { readonly userId: string }): Promise<void> => {
  const userId = uuidOrEmpty("userId", narrow.userId);
  const r = await tx.query<{ ctx: string | null }>("SELECT NULLIF(current_setting('app.ctx', true), '') AS ctx");
  if (r.rows[0]?.ctx == null) throw new Error("narrowContext needs a database context bound first");
  await tx.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
};

/**
 * Runs fn in one transaction with the context bound. Settings vanish at commit or rollback, so pooled
 * connections never leak a context. A role-branded client only accepts the contexts its role may use;
 * the unbranded overload rejects branded clients so the role check cannot be bypassed.
 */
export function withDbContext<R extends DbRole, T>(client: RoleSqlClient<R>, ctx: ContextFor<R>, fn: (tx: Queryable) => Promise<T>): Promise<T>;
export function withDbContext<T>(client: UnbrandedSqlClient, ctx: DbContext, fn: (tx: Queryable) => Promise<T>): Promise<T>;
export function withDbContext<T>(client: SqlClient, ctx: DbContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return client.transaction(async (tx) => {
    await applyDbContext(tx, ctx);
    return fn(tx);
  });
}

/**
 * Production twin of testing.ts roleClient: a SqlClient whose every query and transaction starts with
 * applyDbContext(tx, ctx). Services that run as one role (outlet_auth) build one per request.
 */
export function contextClient<R extends DbRole>(client: RoleSqlClient<R>, ctx: ContextFor<R>): SqlClient;
export function contextClient(client: UnbrandedSqlClient, ctx: DbContext): SqlClient;
export function contextClient(client: SqlClient, ctx: DbContext): SqlClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <Row extends object>(sql: string, params?: readonly unknown[]) => withDbContext(client, ctx, (tx) => tx.query<Row>(sql, params)),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => withDbContext(client, ctx, fn),
  };
}
